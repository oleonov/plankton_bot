import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type { EventBus, OrderBookSnapshot, RuntimeEventMap, RuntimeModule } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { copyBook, copyFacts, EvidenceTransport } from "./transport.js";
import {
  KINDS,
  LIMITS,
  counters,
  identifier,
  type Book,
  type Episode,
  type Kind,
  type Packet,
  type Run,
  type Facts,
  type WorkerMessage,
  type MainMessage,
} from "./types.js";

export interface EvidenceDeps {
  bus: EventBus;
  ledgerPath: string;
  log: Logger;
  book: (token: string, now: number) => { book: OrderBookSnapshot | null; fresh: boolean };
  workerFactory?: () => ChildProcess;
}
export class ExitEvidenceModule implements RuntimeModule {
  private worker: ChildProcess | null = null;
  private workerClosed = false;
  private transport: EvidenceTransport | null = null;
  private unsubs: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  private episodes: Episode[] = [];
  private run: Run | null = null;
  private quality = counters();
  private heartbeatBooks = new Map<string, Book>();
  private credit: number | null = null;
  private status = "off";
  private stopping = false;
  private stopTask: Promise<void> | null = null;
  private abandoned = false;
  private resolveStop: (() => void) | null = null;
  private sentDrops = counters();
  private ackTimer: NodeJS.Timeout | undefined;
  constructor(private readonly deps: EvidenceDeps) {}
  async start(): Promise<void> {
    if (this.worker || this.abandoned || this.status === "failed") return;
    this.stopping = false;
    this.stopTask = null;
    this.workerClosed = false;
    this.episodes = [];
    this.sentDrops = counters();
    this.status = "starting";
    this.transport = new EvidenceTransport((packets, grant) => this.send(packets, grant));
    try {
      this.launchChild();
      for (const kind of KINDS) this.subscribe(kind);
      this.subscribeBooks();
      this.post({
        type: "init",
        parentPid: process.pid,
        ledgerPath: this.deps.ledgerPath,
        path: join(dirname(this.deps.ledgerPath), "exit-evidence.db"),
      });
      this.watchAck();
      this.timer = setInterval(() => this.periodic(), LIMITS.periodicMs);
      this.timer.unref();
    } catch {
      this.fail();
    }
  }
  private launchChild(): void {
    const worker =
      this.deps.workerFactory?.() ??
      fork(new URL("./worker.js", import.meta.url), [], {
        execArgv: [],
        env: {},
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      });
    this.worker = worker;
    this.ownChild(worker);
  }
  private ownChild(worker: ChildProcess): void {
    worker.on("message", (message: WorkerMessage) => this.message(message));
    worker.on("error", () => this.fail());
    worker.on("disconnect", () => {
      if (!this.workerClosed) {
        worker.kill("SIGKILL");
        this.fail();
      }
    });
    worker.on("exit", () => {
      this.worker = null;
      if (!this.workerClosed) this.fail();
      this.credit = null;
      this.resolveStop?.();
    });
  }
  private subscribeBooks(): void {
    this.unsubs.push(
      this.deps.bus.subscribe("MarketSnapshotHeartbeat", async ({ booksByToken }) => {
        if (!this.ready(Date.now())) return;
        for (const e of this.episodes) {
          const book = booksByToken?.get(e.token);
          // Heartbeats carry book timestamps but no cache freshness assertion.
          if (book) this.heartbeatBooks.set(e.token, copyBook(book, false)!);
        }
      }),
    );
  }
  private subscribe<K extends Kind>(kind: K): void {
    this.unsubs.push(
      this.deps.bus.subscribe(kind, async (value: RuntimeEventMap[K]) => {
        try {
          this.capture(kind, value);
        } catch {
          this.transport?.drop("invalid_field");
        }
      }),
    );
  }
  private capture(kind: Kind, value: RuntimeEventMap[Kind]): void {
    const now = Date.now();
    if (!this.ready(now)) return;
    const raw = value as Record<string, unknown>;
    const input = (raw.command ?? raw.position ?? raw) as Record<string, unknown>;
    const facts = copyFacts(input);
    if (!facts) {
      this.transport!.drop("invalid_field");
      return;
    }
    const targets = this.targets(kind, facts);
    const source =
      kind === "PositionUpdated" ? Date.parse(String(facts.updatedAt)) : Number(raw.timestamp);
    const identity =
      kind === "FillReceived"
        ? facts.fillId
        : kind === "PositionUpdated"
          ? `${facts.positionId}:${facts.updatedAt}`
          : facts.commandId;
    if (!identifier(identity)) {
      this.transport!.drop("invalid_field");
      return;
    }
    for (const e of targets) {
      this.transport!.enqueue(
        { slot: e.slot, kind, facts, received: now, source, id: String(identity) },
        kind === "PlaceOrderRequested" && e.command === facts.commandId && this.credit === null,
      );
      this.sample(e, now, kind, source, String(identity));
    }
  }
  private targets(kind: Kind, facts: Facts): Episode[] {
    const targets = this.episodes.filter(
      (e) => e.token === facts.tokenId && e.condition === facts.conditionId,
    );
    if (
      kind !== "PlaceOrderRequested" ||
      facts.source !== "strategy" ||
      facts.side !== "buy" ||
      facts.positionId
    )
      return targets;
    const episode = targets.find((e) => e.client === facts.clientOrderId) ?? this.enroll(facts);
    return episode ? [episode] : [];
  }
  private enroll(f: NonNullable<ReturnType<typeof copyFacts>>): Episode | null {
    if (
      this.credit === null ||
      ![f.clientOrderId, f.commandId, f.signalId, f.tokenId, f.conditionId].every(identifier)
    ) {
      this.transport!.drop("enrollment_drop");
      return null;
    }
    const e: Episode = {
      slot: this.credit,
      client: String(f.clientOrderId),
      command: String(f.commandId),
      signal: String(f.signalId),
      token: String(f.tokenId),
      condition: String(f.conditionId),
      position: null,
      terminal: false,
      ambiguous: false,
    };
    this.credit = null;
    this.episodes.push(e);
    return e;
  }
  private ready(now: number): boolean {
    return (
      !this.stopping &&
      this.status === "ready" &&
      !!this.run &&
      !this.run.disabled &&
      now >= this.run.last_seen &&
      now < this.run.deadline
    );
  }
  private sample(
    e: Episode,
    now: number,
    trigger: string,
    source: number,
    id = `${e.slot}:${now}`,
  ): void {
    const cached = this.deps.book(e.token, now);
    const heartbeat = this.heartbeatBooks.get(e.token);
    const book =
      heartbeat && (heartbeat.time ?? 0) > (cached.book?.timestamp ?? 0)
        ? heartbeat
        : copyBook(cached.book, cached.fresh);
    this.transport!.enqueue({
      slot: e.slot,
      kind: "Book",
      id,
      received: now,
      source,
      facts: { trigger },
      ...(book ? { book } : {}),
    });
  }
  private periodic(): void {
    const now = Date.now();
    if (this.ready(now))
      for (const e of this.episodes)
        if (!e.terminal && !e.ambiguous) this.sample(e, now, "periodic", now);
    this.summary("exit evidence");
  }
  private watchAck(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.fail();
      void this.stop();
    }, 2_000);
    this.ackTimer.unref();
  }
  private send(packets: Packet[], grant: boolean): void {
    this.watchAck();
    this.post({ type: "batch", packets, drops: this.dropDelta(), grant });
  }
  private post(message: MainMessage): void {
    try {
      this.worker?.send(message, (error) => {
        if (error) this.fail();
      });
    } catch {
      this.fail();
    }
  }
  private dropDelta(): ReturnType<typeof counters> {
    const drops = counters();
    for (const key of Object.keys(drops) as (keyof typeof drops)[]) {
      drops[key] = this.transport!.drops[key] - this.sentDrops[key];
      this.sentDrops[key] = this.transport!.drops[key];
    }
    return drops;
  }
  private message(message: WorkerMessage): void {
    if (message.type === "stopped") {
      this.workerClosed = true;
      return;
    }
    if (message.type === "disabled") {
      this.fail();
      return;
    }
    if (!["ready", "ack", "progress"].includes(message.type)) return;
    if (message.type === "progress") this.post({ type: "progressAck" });
    if (message.type !== "progress") clearTimeout(this.ackTimer);
    if (this.stopping) {
      if (message.type === "ack") this.transport?.acknowledge();
      return;
    }
    this.run = message.run;
    this.quality = message.quality;
    // A new local intent may be queued behind the acknowledged batch.
    const unpersisted = this.episodes.filter(
      (e) => !message.episodes.some((row) => row.slot === e.slot),
    );
    this.episodes = [...message.episodes, ...unpersisted].slice(0, LIMITS.chains);
    if (message.credit !== null) this.credit = message.credit;
    this.status = "ready";
    if (message.type === "ready") this.summary("exit evidence ready");
    if (message.type === "ack") this.transport?.acknowledge();
  }
  private fail(): void {
    const first = this.status !== "failed";
    this.status = "failed";
    this.credit = null;
    this.transport?.close();
    if (first) this.summary("exit evidence disabled");
    void this.stop();
  }
  private summary(message: string): void {
    const { quality, drops, ...stats } = this.stats();
    this.deps.log.info(
      {
        exitEvidence: {
          ...stats,
          qualityCount: Object.values(quality).reduce((sum, n) => sum + n, 0),
          dropCount: Object.values(drops).reduce((sum, n) => sum + n, 0),
          bookMissing: this.quality.book_missing,
          bookStale: this.quality.book_stale,
          lifecycleLost: this.quality.lifecycle_drop,
          linkUnknown: this.quality.link_unknown,
          restartGaps: this.quality.restart_gap,
        },
      },
      message,
    );
  }
  stats() {
    return {
      status: this.status,
      captureReady: this.ready(Date.now()),
      spent: this.run?.spent ?? 0,
      episodes: this.episodes.length,
      persistedEvents: this.run?.event_count ?? 0,
      persistedBooks: this.run?.book_count ?? 0,
      persistedThrough: this.run?.last_seen ?? null,
      active: this.episodes.filter((e) => !e.terminal && !e.ambiguous).length,
      // Sparse fixed keys keep the operational summary bounded.
      quality: Object.fromEntries(Object.entries(this.quality).filter(([, n]) => n > 0)),
      queued: this.transport?.size ?? 0,
      bytes: this.transport?.bytes ?? 0,
      drops: Object.fromEntries(
        Object.entries(this.transport?.drops ?? {}).filter(([, n]) => n > 0),
      ),
      abandoned: this.abandoned,
    };
  }
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: JSON.stringify(this.stats()) };
  }
  stop(): Promise<void> {
    return (this.stopTask ??= this.shutdown());
  }
  private async shutdown(): Promise<void> {
    this.stopping = true;
    this.credit = null;
    clearInterval(this.timer);
    this.heartbeatBooks.clear();
    for (const unsub of this.unsubs.splice(0)) unsub();
    clearTimeout(this.ackTimer);
    const worker = this.worker;
    if (!worker) return;
    const acknowledged = await this.waitForShutdown(worker);
    this.resolveStop = null;
    if (!acknowledged) {
      this.abandoned = true;
      this.status = "abandoned";
      worker.unref();
      worker.channel?.unref();
    } else if (this.status !== "failed") this.status = "off";
  }
  private waitForShutdown(worker: ChildProcess): Promise<boolean> {
    return new Promise((resolve) => {
      let sent = false;
      const shutdown = () => {
        if (sent) return;
        sent = true;
        this.transport?.close();
        try {
          worker.send({ type: "shutdown", drops: this.dropDelta() }, () => {});
        } catch {
          resolve(false);
        }
      };
      // Killing isolated SQLite is safe for the parent; ownership lasts until OS exit.
      const kill = setTimeout(() => {
        this.abandoned = true;
        worker.kill("SIGKILL");
      }, 1_900);
      const timeout = setTimeout(() => {
        resolve(false);
      }, 2_000);
      this.resolveStop = () => {
        clearTimeout(kill);
        clearTimeout(timeout);
        resolve(true);
      };
      void (this.transport?.drain() ?? Promise.resolve()).then(shutdown);
    });
  }
}
