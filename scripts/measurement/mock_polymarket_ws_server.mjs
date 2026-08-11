#!/usr/bin/env node
// Throwaway mock Polymarket WS server for R68 Exp 2.
// Listens on ws://127.0.0.1:PORT, accepts subscribe message {type:"market", assets_ids:[...]}
// and streams synthetic price_change / book / best_bid_ask frames at REALISTIC_RATE_HZ
// per connection. Frame shapes follow the parser at packages/exchange/dist/live/market-pricing-record-parser.js.
//
// Honors text "PING" -> sends text "PONG".

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  WebSocketServer,
} = require("~/Work/poly_plankton/node_modules/.pnpm/ws@8.18.3/node_modules/ws");

const PORT = Number(process.env.PORT ?? 8787);
const RATE_HZ = Number(process.env.RATE_HZ ?? 200); // total messages/sec per connection across all subs
const BURST_SIZE = Number(process.env.BURST_SIZE ?? 20); // records per WS frame

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
console.error(
  `[mock-ws] listening on ws://127.0.0.1:${PORT} rate=${RATE_HZ}/s burst=${BURST_SIZE}`,
);

wss.on("connection", (ws) => {
  const subs = new Set(); // token_ids
  let pumpTimer = null;

  ws.on("message", (data) => {
    const text = data.toString();
    if (text === "PING") {
      ws.send("PONG");
      return;
    }
    try {
      const msg = JSON.parse(text);
      const ids = msg.assets_ids ?? msg.token_ids ?? [];
      const op = msg.type === "market" ? "subscribe" : (msg.action ?? "subscribe");
      if (op === "subscribe" || msg.type === "market") {
        for (const id of ids) subs.add(id);
      } else if (op === "unsubscribe") {
        for (const id of ids) subs.delete(id);
      }
      if (pumpTimer === null && subs.size > 0) startPump();
    } catch {
      /* ignore */
    }
  });

  ws.on("close", () => {
    if (pumpTimer) clearInterval(pumpTimer);
  });
  ws.on("error", () => {});

  function startPump() {
    const intervalMs = Math.max(1, Math.round((1000 * BURST_SIZE) / RATE_HZ));
    pumpTimer = setInterval(() => {
      if (subs.size === 0) return;
      const arr = Array.from(subs);
      const batch = [];
      for (let i = 0; i < BURST_SIZE; i++) {
        const tokenId = arr[(Math.random() * arr.length) | 0];
        const r = Math.random();
        if (r < 0.6) {
          // best_bid_ask
          batch.push({
            event_type: "best_bid_ask",
            asset_id: tokenId,
            best_bid: (0.45 + Math.random() * 0.1).toFixed(3),
            best_ask: (0.5 + Math.random() * 0.1).toFixed(3),
            timestamp: Date.now().toString(),
          });
        } else if (r < 0.9) {
          // price_change with embedded sub-changes
          batch.push({
            event_type: "price_change",
            asset_id: tokenId,
            price_changes: [
              {
                asset_id: tokenId,
                best_bid: (0.45 + Math.random() * 0.1).toFixed(3),
                best_ask: (0.5 + Math.random() * 0.1).toFixed(3),
              },
            ],
            timestamp: Date.now().toString(),
          });
        } else {
          // book — heavier
          const bids = [];
          const asks = [];
          for (let k = 0; k < 5; k++) {
            bids.push({
              price: (0.5 - k * 0.01).toFixed(3),
              size: (100 + Math.random() * 500).toFixed(0),
            });
            asks.push({
              price: (0.51 + k * 0.01).toFixed(3),
              size: (100 + Math.random() * 500).toFixed(0),
            });
          }
          batch.push({
            event_type: "book",
            asset_id: tokenId,
            bids,
            asks,
            tick_size: "0.001",
            min_order_size: "5",
            timestamp: Date.now().toString(),
          });
        }
      }
      try {
        ws.send(JSON.stringify(batch));
      } catch {
        // the peer may have gone away mid-burst; the next tick re-checks readyState
      }
    }, intervalMs);
  }
});

process.on("SIGINT", () => {
  wss.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  wss.close();
  process.exit(0);
});
