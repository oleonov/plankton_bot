#!/usr/bin/env node
// Throwaway dev measurement for R68. NOT FOR PROD.
// Spawns 1..N market-pricing-shard-worker instances (NO sockets opened — empty token set)
// and reports parent VmRSS-equivalent (ps -o rss=) for each step.
// macOS has no /proc; Pss unavailable on this platform — see R68 OQ.

import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const WORKER_PATH = join(REPO, "packages/exchange/dist/live/market-pricing-shard-worker.js");
const MAX_WORKERS = Number(process.env.MAX_WORKERS ?? 4);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const REPEAT = Number(process.env.REPEAT ?? 3);

function readRssKB(pid) {
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

function makeWorkerData(workerId) {
  return {
    queueMax: 256,
    lagWarnMs: 1000,
    overflowPolicy: "drop-oldest",
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30_000,
    shardBreakerReconnectsPerMin: 10,
    shardBreakerOpenMs: 30_000,
    shardBreakerOpenMaxMs: 300_000,
    streamStableMs: 30_000,
    workerId,
    heartbeatJitterSeedMs: 0,
    startDelayMs: 0, // immediate activate; still no sockets without tokens
    memorySampleMs: 60_000, // suppress 10s sampler noise during measurement
    memoryWarnRssMb: 100_000, // disable warning
  };
}

async function runOnce(label) {
  // warmup
  const warmupSamples = [];
  for (let i = 0; i < 5; i++) {
    warmupSamples.push(readRssKB(process.pid));
    await wait(1000);
  }
  const baseMedian = median(warmupSamples);
  const baseVarPct = pctSpread(warmupSamples);

  const rows = [{ n: 0, rss_KB: baseMedian, samples_KB: warmupSamples }];
  const workers = [];

  for (let n = 1; n <= MAX_WORKERS; n++) {
    const w = new Worker(WORKER_PATH, { workerData: makeWorkerData(n) });
    workers.push(w);
    // suppress stray messages
    w.on("message", () => {});
    w.on("error", (e) => console.error(`[${label}] worker ${n} error`, e));
    await wait(SETTLE_MS);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push(readRssKB(process.pid));
      await wait(500);
    }
    rows.push({ n, rss_KB: median(samples), samples_KB: samples });
  }

  // tear down
  await Promise.all(workers.map((w) => w.terminate()));

  return { label, baseMedian, baseVarPct, rows };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pctSpread(arr) {
  const m = median(arr);
  const lo = Math.min(...arr);
  const hi = Math.max(...arr);
  return ((hi - lo) / m) * 100;
}

function linreg(points) {
  // y = a + b*x
  const n = points.length;
  const sx = points.reduce((s, [x]) => s + x, 0);
  const sy = points.reduce((s, [, y]) => s + y, 0);
  const sxx = points.reduce((s, [x]) => s + x * x, 0);
  const sxy = points.reduce((s, [x, y]) => s + x * y, 0);
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  const yMean = sy / n;
  const ssTot = points.reduce((s, [, y]) => s + (y - yMean) ** 2, 0);
  const ssRes = points.reduce((s, [x, y]) => s + (y - (a + b * x)) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;
  return { a, b, r2 };
}

async function main() {
  console.error(`[init] node=${process.version} pid=${process.pid} worker=${WORKER_PATH}`);
  const allRuns = [];
  for (let r = 1; r <= REPEAT; r++) {
    console.error(`[run ${r}/${REPEAT}] starting`);
    const result = await runOnce(`run${r}`);
    allRuns.push(result);
    if (r < REPEAT) await wait(10_000);
  }

  // aggregate by N: median across runs
  const byN = new Map();
  for (const run of allRuns) {
    for (const row of run.rows) {
      if (!byN.has(row.n)) byN.set(row.n, []);
      byN.get(row.n).push(row.rss_KB);
    }
  }
  const aggregated = [...byN.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, vals]) => ({
      n,
      median_KB: median(vals),
      median_MiB: median(vals) / 1024,
      spread_pct: pctSpread(vals),
      runs_KB: vals,
    }));

  // regression on N=1..MAX (skip N=0 = baseline)
  const points = aggregated.filter((r) => r.n >= 1).map((r) => [r.n, r.median_MiB]);
  const reg = linreg(points);

  const baseline_MiB = aggregated.find((r) => r.n === 0)?.median_MiB ?? 0;

  const out = {
    node: process.version,
    workerFile: WORKER_PATH,
    repeats: REPEAT,
    settleMs: SETTLE_MS,
    parentBaseline_MiB: baseline_MiB,
    perN: aggregated,
    regression: {
      // y_MiB = a + b * N
      // a = baseline + non-worker overhead; b = per-worker delta = isolate_baseline
      intercept_MiB: reg.a,
      slopePerWorker_MiB: reg.b,
      r2: reg.r2,
    },
    raw: allRuns,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
