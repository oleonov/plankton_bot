#!/usr/bin/env node
/**
 * P2 selection-reporting harness — closed-cohort breakdown for the P&L
 * loss investigation (docs/audits/2026-04-26-pnl-loss-investigation-and-plan.md §4 P2).
 *
 * Reads a ledger DB (default: /app/apps/runtime/data/ledger-live-lite.db when
 * run inside the runtime container; pass --db <path> to override) and emits
 * a markdown report on stdout. The cohort is closed positions with
 * closed_at >= --since (default 2026-04-22, i.e. the 5d window from the audit).
 *
 * Buckets: selection_status × time-to-end (hours from opened_at to end_date)
 *          × first-trade-price (price of first BUY fill on token).
 * Aggregates per bucket: count, sum(cost_basis_usdc), sum(realized_pnl),
 *                        avg(realized_pnl).
 *
 * Caller redirects stdout to docs/audits/<date>-p2-selection-reporting.md.
 *
 * Usage:
 *   node scripts/p2-selection-reporting/report.mjs --db <path> [--since YYYY-MM-DD]
 *
 * Or against prod (script is copied into the container then executed):
 *   ssh root@<host> "docker exec -i krabs-krabs-runtime-1 node /tmp/report.mjs"
 */

import Database from "better-sqlite3";

/**
 * `ledgerInstant()` from @krabs/db, inlined — this script is a standalone .mjs run
 * inside the runtime container with no workspace resolution. Keep the two in sync.
 */
const LEDGER_INSTANT = (column) => `julianday(replace(${column}, '+00', ''))`;

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db ?? "/app/apps/runtime/data/ledger-live-lite.db";
const since = args.since ?? "2026-04-22";

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// `closed_at` is bounded and ordered by INSTANT below, so an unparseable --since would
// silently yield an empty cohort instead of an obviously-wrong one. Fail loudly instead.
if (db.prepare(`SELECT ${LEDGER_INSTANT("?")} AS jd`).get(since).jd === null) {
  console.error(`--since "${since}" is not a timestamp SQLite can parse`);
  process.exit(1);
}

const cohort = db
  .prepare(
    `
  SELECT
    p.position_id,
    p.token_id,
    p.condition_id,
    p.cost_basis_usdc,
    p.realized_pnl,
    p.opened_at,
    p.closed_at,
    p.entry_style,
    m.slug,
    m.event_slug,
    m.end_date,
    m.selection_status,
    -- Position-scoped first BUY: a re-opened token would otherwise inherit
    -- the entry price of the original (now-closed) position. Constraining by
    -- opened_at..closed_at keeps each closed-position row bucketed by the
    -- price of the BUY that actually opened *this* position.
    -- Three subtleties:
    --   (a) fills.filled_at is truncated to seconds while positions.opened_at
    --       carries ms — a 2-second grace absorbs that gap without letting an
    --       old fill leak into a later position's window (re-opens land >> 2s
    --       after the previous close).
    --   (b) closed_at appears in two formats — ISO ("...T...Z") for the SELL/
    --       dust path, and "YYYY-MM-DD HH:MM:SS+00" (note the bare "+00" tz)
    --       for the redeem/resolution path. SQLite's datetime() parser rejects
    --       the bare "+00" suffix and returns NULL, so direct datetime()
    --       comparison silently drops every redeem-closed row. Normalize via
    --       replace(T→space) + substr(1,19) instead — both formats reduce to
    --       the same "YYYY-MM-DD HH:MM:SS" prefix that compares lexically.
    --   (c) for redeem-closed rows the resolution timestamp can land *before*
    --       the local position's opened_at clock-wise; in that case there is
    --       no BUY in the window and first_buy_price stays NULL/unknown.
    (SELECT f.price
       FROM fills f
       WHERE f.token_id = p.token_id
         AND f.side = 'buy'
         AND datetime(f.filled_at) >= datetime(p.opened_at, '-2 seconds')
         AND datetime(f.filled_at) <= substr(replace(p.closed_at, 'T', ' '), 1, 19)
       ORDER BY f.filled_at ASC
       LIMIT 1) AS first_buy_price
  FROM positions p
  LEFT JOIN markets m ON m.token_id = p.token_id
  WHERE p.status = 'closed'
    -- Bounded and ordered by INSTANT, not by text: the two renderings of closed_at
    -- interleave lexically within one calendar day (space 0x20 < 'T' 0x54), so a raw
    -- >= '2026-08-05T05:30:00Z' drops every same-day redeem-closed row, and a raw
    -- ORDER BY interleaves the two formats into a wrong chronology.
    AND ${LEDGER_INSTANT("p.closed_at")} >= ${LEDGER_INSTANT("?")}
  ORDER BY ${LEDGER_INSTANT("p.closed_at")} DESC
`,
  )
  .all(since);

const totalRealized = cohort.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
const totalCostBasis = cohort.reduce((s, r) => s + (r.cost_basis_usdc ?? 0), 0);

console.log(`# P2 selection reporting — closed cohort since ${since}`);
console.log("");
console.log(`Generated: ${new Date().toISOString()}`);
console.log(`Source DB: \`${dbPath}\``);
console.log("");
console.log(
  `Cohort: **${cohort.length}** closed positions; ` +
    `realized PnL = **${totalRealized.toFixed(2)} USDC**; ` +
    `cost basis = **${totalCostBasis.toFixed(2)} USDC**.`,
);
console.log("");

if (cohort.length === 0) {
  console.log("_Empty cohort — nothing to report._");
  process.exit(0);
}

const buckets = new Map();
for (const r of cohort) {
  const key = bucketKey(r);
  const acc = buckets.get(key) ?? {
    sel: bucketSel(r),
    tte: timeToEndBucket(r.opened_at, r.end_date),
    price: priceBucket(r.first_buy_price),
    count: 0,
    costBasis: 0,
    realized: 0,
  };
  acc.count += 1;
  acc.costBasis += r.cost_basis_usdc ?? 0;
  acc.realized += r.realized_pnl ?? 0;
  buckets.set(key, acc);
}

const bucketRows = [...buckets.values()].map((b) => ({
  ...b,
  avgRealized: b.realized / b.count,
  realizedPerDollar: b.costBasis > 0 ? b.realized / b.costBasis : 0,
}));

console.log("## All buckets (selection_status × time-to-end × first-buy-price)");
console.log("");
console.log(
  "| selection_status | time-to-end | first-buy-price | count | sum_cost_basis | sum_realized | avg_realized | realized/cost |",
);
console.log("|---|---|---|--:|--:|--:|--:|--:|");
for (const r of bucketRows.sort((a, b) => a.realized - b.realized)) {
  console.log(
    `| ${r.sel} | ${r.tte} | ${r.price} | ${r.count} | ${r.costBasis.toFixed(2)} | ${r.realized.toFixed(2)} | ${r.avgRealized.toFixed(4)} | ${(r.realizedPerDollar * 100).toFixed(1)}% |`,
  );
}

console.log("");
console.log("## Summary by selection_status");
console.log("");
const bySel = aggBy(cohort, (r) => bucketSel(r));
console.log(
  "| selection_status | count | sum_cost_basis | sum_realized | avg_realized | realized/cost |",
);
console.log("|---|--:|--:|--:|--:|--:|");
for (const [k, v] of [...bySel.entries()].sort()) {
  const ratio = v.costBasis > 0 ? v.realized / v.costBasis : 0;
  console.log(
    `| ${k} | ${v.count} | ${v.costBasis.toFixed(2)} | ${v.realized.toFixed(2)} | ${(v.realized / v.count).toFixed(4)} | ${(ratio * 100).toFixed(1)}% |`,
  );
}

console.log("");
console.log("## Summary by first-buy-price regime");
console.log("");
const byPrice = aggBy(cohort, (r) => priceBucket(r.first_buy_price));
console.log(
  "| first-buy-price | count | sum_cost_basis | sum_realized | avg_realized | realized/cost |",
);
console.log("|---|--:|--:|--:|--:|--:|");
for (const [k, v] of [...byPrice.entries()].sort()) {
  const ratio = v.costBasis > 0 ? v.realized / v.costBasis : 0;
  console.log(
    `| ${k} | ${v.count} | ${v.costBasis.toFixed(2)} | ${v.realized.toFixed(2)} | ${(v.realized / v.count).toFixed(4)} | ${(ratio * 100).toFixed(1)}% |`,
  );
}

console.log("");
console.log("## Summary by time-to-end bucket");
console.log("");
const byTte = aggBy(cohort, (r) => timeToEndBucket(r.opened_at, r.end_date));
console.log(
  "| time-to-end | count | sum_cost_basis | sum_realized | avg_realized | realized/cost |",
);
console.log("|---|--:|--:|--:|--:|--:|");
for (const [k, v] of [...byTte.entries()].sort(tteSort)) {
  const ratio = v.costBasis > 0 ? v.realized / v.costBasis : 0;
  console.log(
    `| ${k} | ${v.count} | ${v.costBasis.toFixed(2)} | ${v.realized.toFixed(2)} | ${(v.realized / v.count).toFixed(4)} | ${(ratio * 100).toFixed(1)}% |`,
  );
}

console.log("");
console.log("## Loss-leader buckets (count ≥ 3, realized ≤ −1 USDC)");
console.log("");
const candidates = bucketRows
  .filter((r) => r.count >= 3 && r.realized <= -1)
  .sort((a, b) => a.realized - b.realized);
if (candidates.length === 0) {
  console.log("_None._");
} else {
  console.log("| bucket | count | sum_cost_basis | sum_realized | avg_realized | realized/cost |");
  console.log("|---|--:|--:|--:|--:|--:|");
  for (const r of candidates) {
    console.log(
      `| ${r.sel} / ${r.tte} / ${r.price} | ${r.count} | ${r.costBasis.toFixed(2)} | ${r.realized.toFixed(2)} | ${r.avgRealized.toFixed(4)} | ${(r.realizedPerDollar * 100).toFixed(1)}% |`,
    );
  }
}

console.log("");
console.log("## Detail: positions in worst bucket");
console.log("");
const worst = bucketRows.sort((a, b) => a.realized - b.realized)[0];
const worstPositions = cohort
  .filter(
    (r) =>
      bucketSel(r) === worst.sel &&
      timeToEndBucket(r.opened_at, r.end_date) === worst.tte &&
      priceBucket(r.first_buy_price) === worst.price,
  )
  .sort((a, b) => (a.realized_pnl ?? 0) - (b.realized_pnl ?? 0));
console.log(
  `Bucket: \`${worst.sel} / ${worst.tte} / ${worst.price}\` — ${worstPositions.length} positions, ` +
    `sum_realized = ${worst.realized.toFixed(2)} USDC.`,
);
console.log("");
console.log("| event_slug | slug | end_date | cost_basis | realized | first_buy_price |");
console.log("|---|---|---|--:|--:|--:|");
for (const r of worstPositions) {
  console.log(
    `| ${r.event_slug ?? "?"} | ${r.slug ?? "?"} | ${r.end_date ?? "?"} | ` +
      `${(r.cost_basis_usdc ?? 0).toFixed(2)} | ${(r.realized_pnl ?? 0).toFixed(2)} | ` +
      `${r.first_buy_price != null ? r.first_buy_price.toFixed(4) : "?"} |`,
  );
}

console.log("");
console.log("## Top-loss event_slugs (rolled up across cohort)");
console.log("");
const bySlug = aggBy(cohort, (r) => r.event_slug ?? "?");
const worstSlugs = [...bySlug.entries()].sort((a, b) => a[1].realized - b[1].realized).slice(0, 15);
console.log("| event_slug | count | sum_cost_basis | sum_realized | realized/cost |");
console.log("|---|--:|--:|--:|--:|");
for (const [slug, v] of worstSlugs) {
  const ratio = v.costBasis > 0 ? v.realized / v.costBasis : 0;
  console.log(
    `| ${slug} | ${v.count} | ${v.costBasis.toFixed(2)} | ${v.realized.toFixed(2)} | ${(ratio * 100).toFixed(1)}% |`,
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

function bucketKey(r) {
  return JSON.stringify([
    bucketSel(r),
    timeToEndBucket(r.opened_at, r.end_date),
    priceBucket(r.first_buy_price),
  ]);
}

function bucketSel(r) {
  return r.selection_status ?? "unknown";
}

function timeToEndBucket(openedAtIso, endDateIso) {
  if (!openedAtIso || !endDateIso) return "unknown";
  const ms = Date.parse(endDateIso) - Date.parse(openedAtIso);
  if (!Number.isFinite(ms)) return "unknown";
  const h = ms / 3_600_000;
  if (h < 0) return "[<0,past)";
  if (h < 1) return "[0,1h)";
  if (h < 6) return "[1,6h)";
  if (h < 24) return "[6,24h)";
  if (h < 72) return "[24,72h)";
  return "[72h,inf)";
}

function priceBucket(p) {
  if (p == null) return "unknown";
  if (p < 0.05) return "<0.05";
  if (p < 0.2) return "0.05-0.20";
  return ">=0.20";
}

function aggBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const acc = m.get(k) ?? { count: 0, costBasis: 0, realized: 0 };
    acc.count += 1;
    acc.costBasis += r.cost_basis_usdc ?? 0;
    acc.realized += r.realized_pnl ?? 0;
    m.set(k, acc);
  }
  return m;
}

function tteSort([a], [b]) {
  const order = ["[<0,past)", "[0,1h)", "[1,6h)", "[6,24h)", "[24,72h)", "[72h,inf)", "unknown"];
  return order.indexOf(a) - order.indexOf(b);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v != null && !v.startsWith("--")) {
        out[k] = v;
        i += 1;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}
