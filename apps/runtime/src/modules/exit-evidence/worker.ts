import { isMainThread, Worker, workerData } from "node:worker_threads";
import type { EvidenceStore } from "./store.js";
import { counters, type MainMessage, type WorkerMessage } from "./types.js";

// This thread never loads SQLite. It can enforce parent ownership while the child
// main thread is blocked in native code, including after abrupt parent death.
if (!isMainThread) {
  const parentPid = workerData as number;
  setInterval(() => {
    if (process.ppid !== parentPid) process.kill(process.pid, "SIGKILL");
  }, 50);
} else {
  process.on("message", (message: MainMessage) => {
    void handle(message).catch(disable);
  });
  process.on("disconnect", () => close());
  process.on("SIGTERM", () => close());
}
let store: EvidenceStore | null = null;
let ledgerPath = "";
let timer: NodeJS.Timeout | undefined;
let stopped = false;
let starting = false;
let progressPending = false;
function post(message: WorkerMessage): void {
  if (!process.connected) return close();
  process.send!(message, (error) => {
    if (error) close();
  });
}
function close(clean = false): void {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  try {
    store?.close(clean);
  } catch {
    post({ type: "disabled" });
  }
  store = null;
  process.removeAllListeners("message");
  // Both connections are closed and no handler can start another native call.
  if (process.connected)
    process.send!({ type: "stopped" }, () => {
      if (process.connected) process.disconnect();
    });
}
function disable(): void {
  post({ type: "disabled" });
  close();
}
function report(type: "ready" | "ack" | "progress", credit: number | null = null): void {
  post({ type, run: store!.run(), episodes: store!.episodes(), quality: store!.counts(), credit });
}
async function initialize(data: Extract<MainMessage, { type: "init" }>): Promise<void> {
  if (starting || stopped) return;
  starting = true;
  if (process.ppid !== data.parentPid) return close();
  const guard = new Worker(new URL(import.meta.url), { workerData: data.parentPid, execArgv: [] });
  guard.on("error", () => process.kill(process.pid, "SIGKILL"));
  guard.unref();
  const { EvidenceStore } = await import("./store.js");
  if (stopped || !process.connected) return close();
  ledgerPath = data.ledgerPath;
  store = new EvidenceStore(data.path, Date.now());
  report("ready", store.credit(Date.now()));
  timer = setInterval(() => {
    try {
      store!.batch([], counters(), Date.now());
      store!.recover(ledgerPath, Date.now());
      if (!progressPending) {
        progressPending = true;
        report("progress");
      }
    } catch {
      disable();
    }
  }, 1_000);
}
async function handle(message: MainMessage): Promise<void> {
  if (stopped) return;
  if (message.type === "init") return initialize(message);
  if (message.type === "progressAck") {
    progressPending = false;
    return;
  }
  if (message.type === "shutdown") {
    if (message.drops) store?.batch([], message.drops, Date.now());
    close(true);
    return;
  }
  if (!store) return;
  const now = Date.now();
  const deferred = store.batch(message.packets, message.drops, now, true);
  store.recover(ledgerPath, now, message.packets);
  if (deferred.length) store.batch(deferred, counters(), now);
  report("ack", message.grant ? store.credit(now) : null);
}
