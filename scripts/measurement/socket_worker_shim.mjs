#!/usr/bin/env node
// Throwaway worker for R68 Exp 2. Replicates the JS-side state of
// WorkerMarketPricingShard (queue + pricingByToken + collectStreamUpdates)
// but connects to a local mock WS instead of Polymarket (blocked locally).
//
// Per-shard imports kept identical to packages/exchange/dist/live/market-pricing-shard-worker.js
// so that the module graph cost matches.

import { parentPort, workerData } from "node:worker_threads";
import { BoundedQueue } from "../../packages/exchange/dist/live/bounded-queue.js";
import { collectStreamUpdates } from "../../packages/exchange/dist/live/market-pricing-record-parser.js";

const cfg = workerData;
const sockets = new Map(); // shardId -> { ws, pricingByToken, queue, subscribed }

function connectShard(shardId, url, tokenIds) {
  const pricingByToken = new Map();
  const queue = new BoundedQueue(cfg.queueMax ?? 256);
  let ws;
  try {
    ws = new globalThis.WebSocket(url);
  } catch (e) {
    parentPort.postMessage({ type: "error", error: String(e) });
    return;
  }
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "market", assets_ids: tokenIds }));
    parentPort.postMessage({ type: "subscribed", shardId, count: tokenIds.length });
  });
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    if (text === "PONG") return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    queue.push(records);
    if (queue.size > 0) {
      // drain synchronously per loop tick (mirrors worker behavior closely)
      while (queue.size > 0) {
        const item = queue.shift();
        collectStreamUpdates(item, pricingByToken, Date.now());
      }
    }
  });
  ws.addEventListener("close", () => {});
  ws.addEventListener("error", () => {});
  sockets.set(shardId, { ws, pricingByToken, queue });
}

parentPort.on("message", (msg) => {
  if (msg.type === "open-shard") {
    connectShard(msg.shardId, msg.url, msg.tokenIds);
  } else if (msg.type === "memory") {
    parentPort.postMessage({
      type: "memory",
      memory: process.memoryUsage(),
      sockets: sockets.size,
    });
  } else if (msg.type === "close") {
    for (const s of sockets.values())
      try {
        s.ws.close();
      } catch {
        // best-effort teardown: a socket the peer already tore down is fine
      }
    sockets.clear();
    process.exit(0);
  }
});

parentPort.postMessage({ type: "ready" });
