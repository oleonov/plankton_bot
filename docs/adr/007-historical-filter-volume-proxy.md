# ADR-007 — Historical universe filter via lifetime-volume proxy

## Status

Accepted — 2026-04-20

## Context

Spec §0 R1 requires a historical universe filter: `trade_count > 0 → INCLUDE; Fallback EXCLUDE`. The intent is to reject markets that have never traded.

Gamma (`/markets`, `/events`) does not expose a `trade_count` field. Empirical probe (`ssh root@old.server.ip 'curl -s "https://gamma-api.polymarket.com/markets?limit=5&active=true"'`, 2026-04-20) surfaces these volume fields on each market:

| Field        | Casing                | Semantic                          | Populated?    |
| ------------ | --------------------- | --------------------------------- | ------------- |
| `volumeNum`  | camelCase             | Lifetime cumulative volume (USDC) | Yes           |
| `volume24hr` | camelCase             | Rolling 24h window                | Yes           |
| `volume_num` | snake_case            | —                                 | Always `null` |
| `volume24Hr` | camelCase (capital H) | —                                 | Always `null` |

Sample row:

```
{
  "slug": "russia-ukraine-ceasefire-before-gta-vi-554",
  "volumeNum":  1568499.88,
  "volume24hr":    5733.78,
  "volume_num":      null,
  "volume24Hr":      null,
  "createdAt":  "2025-05-02T15:03:10Z"
}
```

Prior to this ADR, `mapGammaMarket` read `raw.volume24hr` (rolling 24h) into the domain field named `volume24h`. That would false-exclude older markets which have lifetime activity but no 24h window — the opposite of the spec's intent.

CLOB `/markets` (probed same day) does **not** expose any volume field at all — so markets mapped via `mapMarket` (live CLOB gateway) have `volume24h = null` by construction.

## Decision

### D1 — Use `volumeNum` (lifetime) as the `trade_count > 0` proxy

`mapGammaMarket` reads `raw.volumeNum` (lifetime cumulative USDC volume) rather than `raw.volume24hr`. A positive lifetime volume is a necessary condition for `trade_count > 0` — a market that has never traded cannot have accumulated volume.

The domain field name remains `volume24h` for backward-compat with existing SQLite schema (`volume_24h REAL` on `market_snapshots`), in-flight code, and 27 downstream references. The name is a legacy misnomer; its current semantic is lifetime volume.

### D2 — Filter rule: `volume24h === 0` → EXCLUDE; `null` → pass

`MarketSelectionCache.processMarket` (apps/runtime/src/modules/algo-decision/market-selection-cache.ts) consults `market.volume24h` before running the selection-rule engine:

- `volume24h === 0` → EXCLUDE (never traded — spec §0 R1 "Fallback EXCLUDE").
- `volume24h === null` → unknown; do not block. Typical for CLOB-path markets where the gateway cannot supply lifetime volume.
- `volume24h > 0` → pass through to selection-rule evaluation.

### D3 — Honesty: this is a proxy, not a literal `trade_count`

A market can have `volumeNum > 0` with technically zero "trades" on a strict interpretation (e.g., maker-only quotes that never filled). In practice Gamma only increments `volumeNum` on a completed match, so the proxy is sound for the purpose of "has this market ever had a trade-like event". The ADR explicitly waives strict equivalence and accepts the proxy as the best signal Gamma exposes.

## Consequences

Positive:

- Runtime now honours spec §0 R1 rather than silently dropping the gate.
- False-exclude rate is minimized: a dormant-but-historically-traded market is now admitted, whereas reading `volume24hr` would have excluded it.
- CLOB-path markets (volume unknown) continue to flow — no new false-excludes introduced.

Negative / neutral:

- Field name `volume24h` no longer matches its semantic. Tracked; future cleanup may rename to `volumeLifetime` in a coordinated migration. Not in scope for this ADR.
- `volumeNum` can (rarely) be increased by liquidity flow that isn't strictly a trade. This is accepted per D3.

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md §0` — canonical spec.
- `docs/audits/2026-04-19-algo-spec-remediation-plan.md §4` — execution plan.
- `packages/exchange/src/mappers.ts` — Gamma mapper.
- `apps/runtime/src/modules/algo-decision/market-selection-cache.ts` — filter site.
- `apps/runtime/src/modules/algo-decision/__tests__/market-selection-cache.test.ts` — regression tests.
