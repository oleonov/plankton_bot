import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { InProcessEventBus } from "@krabs/event-bus";
import { bootstrapLedgerDb } from "@krabs/db";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { ExitEvidenceModule } from "../module.js";
import { compiled, buildCompiledFixtures } from "./native-fixture.js";

let dir: string;
beforeAll(buildCompiledFixtures, 65_000);
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "exit-evidence-native-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("measures event-loop overhead including real child IPC serialization and native persistence", async () => {
  const ledgerPath = join(dir, "ledger.db");
  bootstrapLedgerDb(ledgerPath).close();
  const bus = new InProcessEventBus();
  const book = {
    tokenId: "token",
    bestBid: 0.1,
    bestAsk: 0.2,
    timestamp: Date.now(),
    bids: Array.from({ length: 128 }, () => ({ price: 0.1, size: 1 })),
    asks: Array.from({ length: 128 }, () => ({ price: 0.2, size: 1 })),
  } as any;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const module = new ExitEvidenceModule({
    bus,
    ledgerPath,
    log: { info() {} } as any,
    book: () => ({ book, fresh: true }),
    workerFactory: () => {
      const worker = fork(new URL(compiled("worker")), [], {
        env: {},
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      worker.once("message", ready);
      return worker;
    },
  });
  const command = {
    source: "strategy",
    side: "buy",
    commandId: "cmd",
    clientOrderId: "client",
    signalId: "signal",
    tokenId: "token",
    conditionId: "condition",
    price: 0.1,
    size: 10,
  } as const;
  const callbacks: number[] = [],
    delays: number[] = [];
  let sequence = 0;
  try {
    for (const enabled of [false, true]) {
      if (enabled) {
        await module.start();
        await started;
        await bus.publish("PlaceOrderRequested", {
          command: command as any,
          timestamp: Date.now(),
        });
      }
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      const until = performance.now() + 300;
      while (performance.now() < until) {
        for (let i = 0; i < 16; i++) {
          const before = performance.now();
          await bus.publish("FillReceived", {
            ...command,
            orderId: "order",
            fillId: `fill-${sequence++}`,
            sizeUsdc: 1,
            liquidityRole: "maker",
            fee: 0,
            feeRateBps: 0,
            signalReason: null,
            timestamp: Date.now(),
          } as any);
          if (enabled) callbacks.push(performance.now() - before);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      histogram.disable();
      delays.push(histogram.percentile(99) / 1e6);
    }
    callbacks.sort((a, b) => a - b);
    const p99 = callbacks[Math.floor(callbacks.length * 0.99)]!;
    process.stdout.write(
      JSON.stringify({
        nativeCallbackP99Ms: p99,
        eventLoopP99Ms: delays,
        addedP99Ms: delays[1]! - delays[0]!,
        samples: callbacks.length,
        stats: module.stats(),
      }) + "\n",
    );
    expect(module.stats().status).toBe("ready");
    expect(module.stats().persistedEvents).toBeGreaterThan(0);
    expect(module.stats().persistedBooks).toBeGreaterThan(0);
    expect(p99).toBeLessThanOrEqual(1);
    expect(delays[1]! - delays[0]!).toBeLessThanOrEqual(5);
  } finally {
    await module.stop();
  }
});
