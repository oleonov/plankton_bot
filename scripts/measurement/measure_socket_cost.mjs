#!/usr/bin/env node
// R68 Exp 2 — socket_cost via local mock WS (Polymarket blocked locally per CLAUDE.md).
// Spawns: (1) mock WS server child, (2) socket_worker_shim worker thread.
// Measures parent VmRSS-equivalent (ps -o rss=) at:
//   stage A: worker spawned, NO sockets open
//   stage B: 1 mock-WS socket open, 500 token subs, 120s soak (steady-state from last 60s)
//   stage C: 2 mock-WS sockets open, each 500 token subs, 120s soak
// Each stage requires variance < 2% over the last 60s, else extend to 180s.

import { Worker } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM = join(__dirname, "socket_worker_shim.mjs");
const MOCK = join(__dirname, "mock_polymarket_ws_server.mjs");

const PORT = 8787;
const TOKENS_PER_SHARD = Number(process.env.TOKENS_PER_SHARD ?? 500);
const SOAK_MS = Number(process.env.SOAK_MS ?? 120_000);
const MEASURE_MS = Number(process.env.MEASURE_MS ?? 60_000);
const SAMPLE_INTERVAL_MS = 10_000;
const REPEAT = Number(process.env.REPEAT ?? 2);
const NUM_SOCKETS = Number(process.env.NUM_SOCKETS ?? 2);

function readRssKB(pid) {
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(r.stdout.trim());
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pctSpread(arr) {
  if (arr.length === 0) return Infinity;
  const m = median(arr);
  return ((Math.max(...arr) - Math.min(...arr)) / m) * 100;
}
function fakeTokenIds(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(String(BigInt(10) ** BigInt(70) + BigInt(start * 1_000_000 + i)));
  }
  return out;
}

async function soakAndMeasure(label) {
  // Take samples every SAMPLE_INTERVAL_MS through the soak; keep last (MEASURE_MS / interval) ones.
  const samples = [];
  const tStart = Date.now();
  while (Date.now() - tStart < SOAK_MS) {
    await wait(SAMPLE_INTERVAL_MS);
    const rss = readRssKB(process.pid);
    const elapsed = Date.now() - tStart;
    samples.push({ elapsedMs: elapsed, rss_KB: rss });
  }
  const measureFromMs = SOAK_MS - MEASURE_MS;
  const steady = samples.filter((s) => s.elapsedMs >= measureFromMs).map((s) => s.rss_KB);
  const variance = pctSpread(steady);
  // Variance check: extend to 180s if > 2%
  let extended = false;
  if (variance > 2 && SOAK_MS < 180_000) {
    extended = true;
    const tExt = Date.now();
    while (Date.now() - tExt < 180_000 - SOAK_MS) {
      await wait(SAMPLE_INTERVAL_MS);
      samples.push({ elapsedMs: SOAK_MS + (Date.now() - tExt), rss_KB: readRssKB(process.pid) });
    }
    const measureFromExt = 180_000 - MEASURE_MS;
    const steadyExt = samples.filter((s) => s.elapsedMs >= measureFromExt).map((s) => s.rss_KB);
    return {
      label,
      samples,
      steady: steadyExt,
      median_KB: median(steadyExt),
      variance_pct: pctSpread(steadyExt),
      extended,
    };
  }
  return { label, samples, steady, median_KB: median(steady), variance_pct: variance, extended };
}

async function runOnce(repeatIdx) {
  // 1. Start mock server child
  const server = spawn(process.execPath, [MOCK], {
    env: { ...process.env, PORT: String(PORT), RATE_HZ: "200", BURST_SIZE: "20" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mock server timed out")), 5000);
    server.stderr.on("data", (b) => {
      if (b.toString().includes("listening")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  console.error(`[r${repeatIdx}] mock server pid=${server.pid}`);

  try {
    // 2. Spawn shim worker
    const worker = new Worker(SHIM, {
      workerData: { queueMax: 256 },
    });
    await new Promise((resolve) => worker.once("message", (m) => m.type === "ready" && resolve()));
    worker.on("message", (m) => {
      if (m.type === "error") console.error(`[r${repeatIdx}] shim error`, m);
    });

    // 3. Stage A: worker, no sockets
    await wait(5000);
    const stageA_samples = [];
    for (let i = 0; i < 5; i++) {
      stageA_samples.push(readRssKB(process.pid));
      await wait(500);
    }
    const stageA_rss_KB = median(stageA_samples);
    console.error(
      `[r${repeatIdx}] stageA (no sockets) rss=${(stageA_rss_KB / 1024).toFixed(1)} MiB spread=${pctSpread(stageA_samples).toFixed(1)}%`,
    );

    // 4. Stage B: open socket 1
    worker.postMessage({
      type: "open-shard",
      shardId: 0,
      url: `ws://127.0.0.1:${PORT}`,
      tokenIds: fakeTokenIds(0, TOKENS_PER_SHARD),
    });
    const stageB = await soakAndMeasure("stageB");
    console.error(
      `[r${repeatIdx}] stageB (1 socket) median=${(stageB.median_KB / 1024).toFixed(1)} MiB variance=${stageB.variance_pct.toFixed(2)}% extended=${stageB.extended}`,
    );

    let stageC = null;
    if (NUM_SOCKETS >= 2) {
      worker.postMessage({
        type: "open-shard",
        shardId: 1,
        url: `ws://127.0.0.1:${PORT}`,
        tokenIds: fakeTokenIds(1, TOKENS_PER_SHARD),
      });
      stageC = await soakAndMeasure("stageC");
      console.error(
        `[r${repeatIdx}] stageC (2 sockets) median=${(stageC.median_KB / 1024).toFixed(1)} MiB variance=${stageC.variance_pct.toFixed(2)}% extended=${stageC.extended}`,
      );

      // nonlinearity guard
      const delta1 = stageB.median_KB - stageA_rss_KB;
      const delta2 = stageC.median_KB - stageB.median_KB;
      if (delta2 / 1024 > 100) {
        console.error(
          `[r${repeatIdx}] nonlinearity guard tripped: 2nd-socket delta=${(delta2 / 1024).toFixed(1)} MiB > 100 MiB`,
        );
      }
      console.error(
        `[r${repeatIdx}] per-socket delta1=${(delta1 / 1024).toFixed(1)} MiB, delta2=${(delta2 / 1024).toFixed(1)} MiB`,
      );
    }

    // Tear down
    worker.postMessage({ type: "close" });
    await worker.terminate();

    return { repeatIdx, stageA_rss_KB, stageA_samples, stageB, stageC };
  } finally {
    server.kill("SIGTERM");
    await wait(500);
  }
}

async function main() {
  console.error(`[init] node=${process.version} pid=${process.pid}`);
  const runs = [];
  for (let r = 1; r <= REPEAT; r++) {
    console.error(`[main] starting repeat ${r}/${REPEAT}`);
    runs.push(await runOnce(r));
    if (r < REPEAT) await wait(30_000);
  }

  // Aggregate across runs
  const stageA_meds = runs.map((r) => r.stageA_rss_KB);
  const stageB_meds = runs.map((r) => r.stageB.median_KB);
  const stageC_meds = runs.filter((r) => r.stageC).map((r) => r.stageC.median_KB);
  const perSocket1 = runs.map((r) => r.stageB.median_KB - r.stageA_rss_KB);
  const perSocket2 = runs
    .filter((r) => r.stageC)
    .map((r) => r.stageC.median_KB - r.stageB.median_KB);

  const out = {
    node: process.version,
    tokensPerShard: TOKENS_PER_SHARD,
    soakMs: SOAK_MS,
    measureMs: MEASURE_MS,
    repeats: REPEAT,
    aggregate: {
      stageA_median_MiB: median(stageA_meds) / 1024,
      stageA_spread_pct: pctSpread(stageA_meds),
      stageB_median_MiB: median(stageB_meds) / 1024,
      stageB_spread_pct: pctSpread(stageB_meds),
      stageC_median_MiB: stageC_meds.length ? median(stageC_meds) / 1024 : null,
      stageC_spread_pct: stageC_meds.length ? pctSpread(stageC_meds) : null,
      firstSocketDelta_MiB: median(perSocket1) / 1024,
      secondSocketDelta_MiB: perSocket2.length ? median(perSocket2) / 1024 : null,
      socketCostAvg_MiB: stageC_meds.length
        ? (median(stageC_meds) - median(stageA_meds)) / 2 / 1024
        : null,
    },
    runs,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
