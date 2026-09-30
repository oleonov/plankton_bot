# Startup pending BUY recovery — 2026-09-22

The incident has two BUYs on the same closed, zero-sized owner:

- `0x3135ceab9c3793530c5dbc6e156ff983ed46f45a3492d1d9b4d1a56f777a147b`: exact lookup returned literal null.
- `0x62e8bdcd417d92718dbfa55503da13a7ec99193404a653ad2ec79bca10f791b6`: exact LIVE, matched zero, submitted size 114.99; the only remote open order.

Both local sizes are 114.99999999999999 at 0.006. Owner:
`pos-60439806692871734282263527699857865985707456979301205077689278354683462925765-1789717777463`.
Wallet quantity is unknown. The original process death has **cause unknown**; this is not an OOM fix.

Startup stages reliable fills, open orders and exact observations before adoption. One unknown
BUY and independently validated working siblings receive atomic, identity-bound recovery markers.
Additional unknowns, foreign owners, unsupported SELLs, contradictory snapshots or malformed
markers fail closed. Existing maker and SELL recovery restrictions remain in force.

Each protected member must remain an exact transition target until a current exact terminal
response and committed inventory coverage complete recovery in one SQLite transaction. Saved
but unapplied fills retain reservation coverage. Consumed lots count by original applied quantity.
Restart discovers markers independently of local status and reacquires exact evidence. A single
null lookup does not authorize terminalization, signing, reposting or replacement. A member closes
as cancelled (`exchange-exact-null-absent`) only under the durable exchange-absence rule
(operator-approved 2026-09-30): absent from a reliable open-orders snapshot and exact null in the
same pass, an `exchangeAbsenceV1` marker at least 24h old with no fill since, 7 days without any
activity, and a reliable same-pass fill re-read from creation with no deferred fill. Completion
still needs a current recovery owner and committed inventory covering the recorded matched
quantity, written in one transaction with the status; the user-stream catch-up never closes.
Only claimed `startup_pending_buy_recovery` cancellations may drain these exact IDs; the token
stays blocked until both members complete. Newly created positions use the normal exit-owner policy.

Release verification must check both IDs, visible unresolved quarantine, stable restart count,
advancing heartbeat with matching instance/run/profile, reconciliation and market-data progress,
and continuing collector output. Restore the pre-deploy running/paused state. Recovery does not
require inventing a terminal verdict for the unknown order. Do not reset collectors or remove
markers to force a green release. Runtime status must expire even if API requests remain pending;
SSE connectivity only demonstrates API connectivity.
