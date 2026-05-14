# ADR-009 — Mark-to-market policy for current_value_usdc

## Status

Accepted — 2026-05-14

## Context

positions.current_value_usdc is mark-to-market value of the open
residual (size × current price). It feeds UI P&L, equity snapshots,
totalExposure, and wallet-sentinel micro-dust classification. It does
NOT feed trading decisions (algo-decision does not read it).

Two writers can update the field:

- W4: RiskInventoryModule.handleMarketUpdate on NormalizedMarketUpdated,
  using local CLOB midPrice.
- W5: wallet-position-sentinel via Polymarket data-api currentValue,
  every reconciliation cycle (~15s).

Prior decision (commit bc7bcb6, 2026-05-08): in live-lite, W4 was
disabled to avoid competing with W5; Polymarket data-api was chosen
as the authoritative source. This left a gap: when Polymarket
data-api stops returning a token (effectively-closed positions
including dust), W5 has no value to write, and current_value_usdc
freezes at whatever was last written. In prod (2026-05-14) 7 of 42
open positions are affected with implied prices >$1 (impossible on
Polymarket).

## Decision

### D1 — W5 is the primary writer in live-lite

When Polymarket data-api returns a position, its currentValue is
authoritative. W4 must defer.

### D2 — W4 is a staleness-gated fallback

W4 writes only when one of:

- currentValueUsdc is NULL, or
- currentValueUsdc / size > 1.0 (strictly, with 1e-9 epsilon to
  avoid floating-point boundary issues; implied price > $1 is impossible), or
- now - updatedAt > 60s (W5 had at least 4 cycles to update).

### D3 — W5 sanity check

W5 rejects remote.currentValueUsdc > size (implied price > $1). Such
values are upstream bugs and must not be persisted.

### D4 — One-shot startup backfill

RiskInventoryModule on start() recomputes current_value_usdc for
active positions where the stored value is NULL or implausible
(criterion same as D2 (i)+(ii)), using the latest known market
snapshot midpoint.
Backfill applies to all active positions (status IN ('open','dust')),
not just open — dust positions also surface in UI/equity totals and
benefit from the same correction.

### D5 — Trading logic is unaffected

`algo-decision` does not read `current_value_usdc` directly. D-rules
D1-D8 operate on `position.size`, `cumulative_*`, and `currentPrice`,
not on `current_value_usdc`.

## Notes

- The 60s staleness threshold is configurable as
  W4_STALENESS_FALLBACK_MS in
  apps/runtime/src/modules/risk-inventory/risk-inventory-module.ts.
- No env-var override in current PR; if production tuning is needed
  later, expose via env.
