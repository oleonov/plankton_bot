# Runtime Latency Budgets

These tests guard against the Track H sync-blocking pattern: a publisher awaits an event-bus subscriber
that performs external IO or many synchronous DB writes.

## Critical publisher budgets

- `MarketResolvedHint` publisher: subscriber must return immediately; resolution cancel/Gamma/redeem work
  runs through the bounded async resolution queue.
- `RedeemRequested` publisher: subscriber must return immediately; algo redeem work runs through the same
  FIFO queue.
- Reconciliation wallet snapshot: one data-api read per pass, soft timeout 2 seconds.
- Reconciliation `publishExchangeState`: preserved below 100 ms in normal local tests; wallet-event sweep
  remains async via Track H.
- Signal-to-order observation writes: order publication must not wait for synchronous observation inserts.
- Candidate-book fresh-entry wait: 25 ms max before fallback.

## Regression test locations

- `apps/runtime/src/__tests__/resolution-module.test.ts`
- `apps/runtime/src/__tests__/reconciliation-module.test.ts`
- `apps/runtime/src/__tests__/risk-inventory-module.test.ts`
- `apps/runtime/src/__tests__/signal-to-order-bridge.test.ts`
- `apps/runtime/src/__tests__/wallet-order-capacity.test.ts`

Any future subscriber that needs slow RPC, HTTP, on-chain, or high-volume DB work should use the Track H
bounded FIFO pattern and should add a publisher-latency test before implementation.
