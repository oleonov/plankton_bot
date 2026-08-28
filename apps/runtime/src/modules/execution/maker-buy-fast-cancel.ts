import { randomUUID } from "node:crypto";
import { createCommandId, type EventBus, type OrderRepository } from "@krabs/domain";

export type MakerBuyFastCancelResult = "applied" | "deferred" | "rejected";
export type MakerBuyFastCancelCommit = (completedAt: string) => Promise<void>;

export interface MakerBuyFastCancelDeps {
  orderRepo: Pick<OrderRepository, "findOpen"> &
    Partial<
      Pick<
        OrderRepository,
        "findById" | "findRecoverableMakerCaptureRepriceIntents" | "markMakerCaptureRepriceTerminal"
      >
    >;
  bus: EventBus;
  isMakerModeOff: () => boolean;
  inFlightMakerBuys: () => number;
  inFlightPermanentR23?: (activationId: string) => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rescanMs?: number;
  deadlineMs?: number;
}

/** Coordinates a narrow, durable maker-BUY drain; execution still owns cancellation. */
export class MakerBuyFastCancel {
  private ready = false;
  private latched = false;
  private readonly permanentLatches = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rescanMs: number;
  private readonly deadlineMs: number;

  constructor(private readonly deps: MakerBuyFastCancelDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rescanMs = deps.rescanMs ?? 1_000;
    this.deadlineMs = deps.deadlineMs ?? 60_000;
  }

  setReady(ready: boolean): void {
    this.ready = ready;
  }

  isLatched(): boolean {
    return this.latched;
  }

  isPermanentLatched(activationId: string): boolean {
    return this.permanentLatches.has(activationId);
  }

  async cancelPermanentActivation(
    activationId: string,
    commit: MakerBuyFastCancelCommit,
  ): Promise<MakerBuyFastCancelResult> {
    if (!activationId || !this.ready) return this.ready ? "rejected" : "deferred";
    this.permanentLatches.add(activationId);
    const deadline = this.now() + this.deadlineMs;
    for (;;) {
      const intents = this.drainPermanentIntents(activationId);
      const targets = this.findPermanentTargets(activationId);
      for (const order of targets) {
        await this.deps.bus.publish("CancelOrderRequested", {
          command: {
            type: "CancelOrderCommand",
            commandId: createCommandId(
              `permanent-r23-cancel-${activationId}-${String(order.orderId)}`,
            ),
            orderId: order.orderId,
            reason: "maker_fast_cancel",
          },
          timestamp: this.now(),
        });
      }
      if (
        targets.length === 0 &&
        intents === 0 &&
        (this.deps.inFlightPermanentR23?.(activationId) ?? 0) === 0 &&
        this.findPermanentTargets(activationId).length === 0 &&
        this.drainPermanentIntents(activationId) === 0
      ) {
        await commit(new Date(this.now()).toISOString());
        this.permanentLatches.delete(activationId);
        return "applied";
      }
      if (this.now() >= deadline) return "rejected";
      await this.sleep(this.rescanMs);
    }
  }

  async cancelSince(
    activationTs: string,
    commit: MakerBuyFastCancelCommit,
  ): Promise<MakerBuyFastCancelResult> {
    const invocationNonce = randomUUID();
    const activationMs = canonicalInstant(activationTs);
    if (activationMs == null || !this.deps.isMakerModeOff()) return "rejected";
    if (!this.ready) return "deferred";
    this.latched = true;
    const deadline = this.now() + this.deadlineMs;
    let cancelSequence = 0;
    for (;;) {
      if (!this.ready || !this.deps.isMakerModeOff()) return "rejected";
      const targets = this.findTargets(activationMs);
      for (const order of targets) {
        await this.deps.bus.publish("CancelOrderRequested", {
          command: {
            type: "CancelOrderCommand",
            commandId: createCommandId(
              `maker-fast-cancel-${invocationNonce}-${activationTs}-${String(order.orderId)}-${cancelSequence++}`,
            ),
            orderId: order.orderId,
            reason: "maker_fast_cancel",
          },
          timestamp: this.now(),
        });
      }
      if (
        targets.length === 0 &&
        this.deps.inFlightMakerBuys() === 0 &&
        this.findTargets(activationMs).length === 0
      ) {
        if (!this.deps.isMakerModeOff()) return "rejected";
        const completedAt = new Date(this.now()).toISOString();
        await commit(completedAt);
        this.latched = false;
        return "applied";
      }
      if (this.now() >= deadline) return "rejected";
      await this.sleep(this.rescanMs);
    }
  }

  private findTargets(activationMs: number) {
    return this.deps.orderRepo
      .findOpen()
      .filter(
        (order) =>
          order.side === "buy" &&
          order.entryStyle === "maker" &&
          new Date(order.createdAt).getTime() >= activationMs,
      );
  }

  private findPermanentTargets(activationId: string) {
    return this.deps.orderRepo.findOpen().filter((order) => {
      const origin = order.metadata?.quoteMotionV1 as Record<string, unknown> | undefined;
      return origin?.permanentR23ActivationId === activationId;
    });
  }

  private drainPermanentIntents(activationId: string): number {
    const find = this.deps.orderRepo.findRecoverableMakerCaptureRepriceIntents;
    const mark = this.deps.orderRepo.markMakerCaptureRepriceTerminal;
    if (!find) return 0;
    const matching = () =>
      find.call(this.deps.orderRepo).filter((intent) => {
        const root = this.deps.orderRepo.findById?.(intent.rootOrderId);
        const origin = root?.metadata?.quoteMotionV1 as Record<string, unknown> | undefined;
        return origin?.permanentR23ActivationId === activationId;
      });
    for (const intent of matching())
      mark?.call(this.deps.orderRepo, intent.intentId, "failed", "permanent-r23-deactivated");
    return matching().length;
  }
}

export function canonicalInstant(value: string | null): number | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : null;
}
