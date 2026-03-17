import type { EventBus, RuntimeEventMap } from "@plankton/domain";

type Handler = (payload: never) => Promise<void>;

export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly inflight = new Set<Promise<void>>();

  async publish<K extends keyof RuntimeEventMap>(
    event: K,
    payload: RuntimeEventMap[K],
  ): Promise<void> {
    const subs = this.handlers.get(event);
    if (!subs?.size) return;

    const settled = Promise.allSettled(
      [...subs].map((fn) => fn(payload as never)),
    ).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") console.error(r.reason);
      }
    });

    const tracked = settled.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    await settled;
  }

  subscribe<K extends keyof RuntimeEventMap>(
    event: K,
    handler: (payload: RuntimeEventMap[K]) => Promise<void>,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const h = handler as Handler;
    set.add(h);

    return () => { set.delete(h); };
  }

  async drain(timeoutMs?: number): Promise<void> {
    if (!this.inflight.size) return;

    const pending = Promise.allSettled([...this.inflight]).then(() => {});

    if (timeoutMs === undefined) {
      await pending;
      return;
    }

    await Promise.race([
      pending,
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}
