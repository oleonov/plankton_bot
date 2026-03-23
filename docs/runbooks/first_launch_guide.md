# First Launch Guide

This guide is the practical next step after Phase 15.

There are no new large implementation phases left in the current v1 plan. The next work is operational:

1. local smoke run in `simulation`
2. `paper` sign-off
3. `live-lite` preflight
4. first narrow `live-lite` session
5. post-run review and small fixes if needed

Use this file as the "start here" guide. For the detailed procedures after paper sign-off, also use:

- `docs/runbooks/paper_signoff.md`
- `docs/runbooks/live_lite_preflight.md`
- `docs/runbooks/live_lite_rollout.md`

## What You Need Before The First Run

### Local API key

You need one local API key for the operator API and web UI:

- `PLANKTON_API_KEY`

This is not a Polymarket key. It is just a local bearer token for the API/UI.

Use a long random string.

### Polymarket CLOB credentials

You need real Polymarket credentials for `paper` and `live-lite`:

- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`

You do not need them for the initial `simulation` smoke run.

### Separate SQLite files per mode

Do not reuse the same DB file across all modes. Keep them separate:

- `./apps/runtime/data/plankton-sim.db`
- `./apps/runtime/data/plankton-paper.db`
- `./apps/runtime/data/plankton-live-lite.db`

### One important note about `.env.example`

The current `.env.example` still mentions:

- `simulation | paper | live`

The code now expects:

- `simulation | paper | live-lite`

Do not use `live`. Use `live-lite`.

### One important note about `config/family_rules.yaml`

For the first smoke run, the family rules file only needs to be schema-valid.

The minimal valid contents are:

```yaml
version: 1
families: []
```

This is enough to boot the platform and verify runtime/API/UI wiring.

For real `paper` and `live-lite` runs, replace it with actual family rules or adapt:

- `docs/family_rules_template_v1.yaml`

> The template uses multi-family format. To set a custom starting balance for simulation/paper
> mode, edit `global.initial_balance_usdc` in `config/family_rules.yaml`. Default is $10,000.
> This field is ignored in live-lite mode (real Polymarket balance is used).

## Recommended Files To Create

Create three local env files in the repo root:

- `.env.simulation`
- `.env.paper`
- `.env.live-lite`

Before each run, copy the one you want into `.env`.

Example:

```bash
cp .env.simulation .env
```

Both `@plankton/runtime` and `@plankton/api` read the same `.env`.

## Env Template: Simulation

Use this for the first smoke run.

```env
RUNTIME_MODE=simulation
LOG_LEVEL=info
DB_PATH=./apps/runtime/data/plankton-sim.db
FAMILY_RULES_PATH=./config/family_rules.yaml
# Starting balance is configured in family_rules.yaml under global.initial_balance_usdc (not in env)
PLANKTON_API_KEY=replace-with-a-long-random-string
PLANKTON_API_PORT=3100
```

## Env Template: Paper

Use this only after the first smoke run is understood.

```env
RUNTIME_MODE=paper
LOG_LEVEL=info
DB_PATH=./apps/runtime/data/plankton-paper.db
FAMILY_RULES_PATH=./config/family_rules.yaml
# Starting balance is configured in family_rules.yaml under global.initial_balance_usdc (not in env)
PLANKTON_API_KEY=replace-with-a-long-random-string
PLANKTON_API_PORT=3100

POLY_API_KEY=replace
POLY_API_SECRET=replace
POLY_PASSPHRASE=replace
```

## Env Template: Live-Lite

Use this only after paper sign-off is clean.

```env
RUNTIME_MODE=live-lite
LOG_LEVEL=info
DB_PATH=./apps/runtime/data/plankton-live-lite.db
FAMILY_RULES_PATH=./config/family_rules.yaml
PLANKTON_API_KEY=replace-with-a-long-random-string
PLANKTON_API_PORT=3100

POLY_API_KEY=replace
POLY_API_SECRET=replace
POLY_PASSPHRASE=replace

LIVE_LITE_CONFIRM=true
LIVE_LITE_FAMILY_ALLOWLIST=fam-xxx
LIVE_LITE_MAX_FAMILIES=1
LIVE_LITE_MAX_OPEN_VALUE_USDC=50
LIVE_LITE_MAX_ORDER_USDC=10
LIVE_LITE_MAX_ACTIVE_MARKETS=2
```

### Budget for simulation / paper mode

The simulated starting balance is set in `config/family_rules.yaml`:

```yaml
global:
  initial_balance_usdc: 100.00  # match your planned live-lite deposit
```

When the balance runs out, new buy orders are rejected with `INSUFFICIENT_BALANCE`. Sells return funds to the balance, so the bot can recycle capital. The balance resets on every restart. This field is ignored in live-lite mode (real Polymarket balance is used).

## Step 1: First Local Smoke Run In Simulation

### Goal

This run is not for performance or strategy validation.

It is only to confirm that:

- runtime starts
- API starts
- web UI loads
- auth works
- SSE works
- pause/resume is visible and behaves correctly

### Important limitation

`simulation` mode uses simulated market data and simulated execution.

Out of the box, this is not the best mode to see meaningful trading behavior. It is a smoke run for platform sanity, not a true trading validation run.

### Commands

Prepare directories:

```bash
mkdir -p apps/runtime/data logs snapshots
```

Select the env:

```bash
cp .env.simulation .env
```

Build once:

```bash
pnpm build
```

Start runtime in terminal 1:

```bash
pnpm --filter @plankton/runtime start 2>&1 | tee logs/runtime-sim-$(date +%Y%m%d-%H%M%S).log
```

Start API in terminal 2:

```bash
pnpm --filter @plankton/api start 2>&1 | tee logs/api-sim-$(date +%Y%m%d-%H%M%S).log
```

Open the UI:

- `http://localhost:3100`

In browser devtools console, set the API key once:

```js
localStorage.setItem("plankton_api_key", "my_api_key_123456");
location.reload();
```

### What to verify in the UI

On `Overview`:

- `runtimeMode = simulation`
- market-data / execution mode show simulation, not live
- SSE is connected
- the page updates without auth errors

Also check:

- `Families` page loads
- `Risk` page loads
- `Pause` changes visible state
- `Resume` restores visible state

### What is acceptable during this smoke run

It is acceptable if you do not see meaningful signals, orders, or fills yet. This run is mainly about understanding the UI and confirming the platform boots cleanly.

### What to save after the smoke run

Set a local shell variable for snapshots:

```bash
API_KEY='replace-with-the-same-PLANKTON_API_KEY'
```

Save a status snapshot:

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/v1/status \
  > snapshots/status-sim.json
```

Also save:

- runtime log file from `logs/`
- API log file from `logs/`
- screenshot of `Overview`
- screenshot of `Risk`

### Stop conditions for the smoke run

Stop and fix before going to `paper` if any of these happen:

- runtime crashes
- API crashes
- UI cannot authenticate
- SSE never connects
- pause/resume does not change visible state

## Step 2: Get Polymarket CLOB Credentials

Before `paper` or `live-lite`, obtain:

- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`

Without these, the runtime cannot run in `paper` or `live-lite`.

## Step 3: Paper Sign-Off

### Goal

This is the first meaningful validation run.

`paper` means:

- market data is live
- strategy/risk/reconciliation are real
- execution is simulated
- no real orders are placed on the exchange

### Before you start

Copy the paper env:

```bash
cp .env.paper .env
```

Build if needed:

```bash
pnpm build
```

Start runtime:

```bash
pnpm --filter @plankton/runtime start 2>&1 | tee logs/runtime-paper-$(date +%Y%m%d-%H%M%S).log
```

Start API:

```bash
pnpm --filter @plankton/api start 2>&1 | tee logs/api-paper-$(date +%Y%m%d-%H%M%S).log
```

Set the API key in browser `localStorage` if needed.

### Expected top-level UI state

On `Overview`, you should expect:

- `runtimeMode = paper`
- market data source is live
- execution mode is simulation
- SSE connected
- no active reconciliation drift
- market data stays fresh

### How long to run

Run for at least 2 hours.

### What to look at during the run

Main pages:

- `Overview`
- `Families`
- `Risk`
- `Orders/Fills`

Main questions:

- are signals being produced?
- are signals approved/rejected as expected?
- are simulated orders created?
- are simulated fills processed?
- are positions and family states updating?
- is reconciliation clean?
- are there any unexpected ERROR-level logs?

### Checkpoint schedule

Use these checkpoints:

- `T+0`
- `T+15m`
- `T+30m`
- `T+60m`
- `T+120m`

At each checkpoint:

1. save `Overview` screenshot
2. save `Risk` screenshot
3. save API snapshots

Use:

```bash
API_KEY='replace-with-the-same-PLANKTON_API_KEY'
SESSION='paper'
TS=$(date +%Y%m%d-%H%M%S)

curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/v1/status \
  > snapshots/${SESSION}-status-${TS}.json

curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/v1/metrics \
  > snapshots/${SESSION}-metrics-${TS}.json

curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/v1/families \
  > snapshots/${SESSION}-families-${TS}.json

curl -s -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3100/api/v1/orders?limit=50" \
  > snapshots/${SESSION}-orders-${TS}.json

curl -s -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3100/api/v1/fills?limit=100" \
  > snapshots/${SESSION}-fills-${TS}.json

curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/v1/risk-events \
  > snapshots/${SESSION}-risk-events-${TS}.json
```

### What counts as failure in paper mode

Do not move to `live-lite` if any of these happen:

- runtime crash or unhandled exception
- API crash
- market data remains stale for more than 5 minutes
- active reconciliation drift
- no signals after 30 minutes
- obviously impossible position or family state
- repeated unexpected ERROR-level log entries

### What counts as success in paper mode

Paper sign-off is good enough to move forward when:

- signals are flowing
- simulated orders/fills are appearing
- positions update coherently
- family states update coherently
- reconciliation stays clean
- no unresolved stale-data or drift problems persist

## Step 4: What To Bring Back After Paper Sign-Off

After the 2-hour paper run, bring back:

- runtime log file
- API log file
- latest `/api/v1/status`
- latest `/api/v1/metrics`
- latest `/api/v1/families`
- latest `/api/v1/orders?limit=50`
- latest `/api/v1/fills?limit=100`
- latest `/api/v1/risk-events`
- screenshots of `Overview` at start and end
- screenshots of `Risk` or `Families` at start and end

Also write a short summary:

- were there signals?
- were there fills?
- was there any reconciliation drift?
- was there any stale-data period?
- were there unexpected rejects or errors?

This is the package to review before first `live-lite`.

## Step 5: Live-Lite Preflight

Do not do this until paper sign-off is clean.

Use:

- `docs/runbooks/live_lite_preflight.md`

The purpose of preflight is to verify:

- real credentials are present
- allowlist is defined
- caps are defined
- current DB state does not violate the live-lite envelope
- runtime either starts cleanly or starts paused with clear violations

### Session 1 envelope

Use the narrow session-1 envelope:

- `LIVE_LITE_FAMILY_ALLOWLIST=fam-xxx`
- `LIVE_LITE_MAX_FAMILIES=1`
- `LIVE_LITE_MAX_OPEN_VALUE_USDC=50`
- `LIVE_LITE_MAX_ORDER_USDC=10`
- `LIVE_LITE_MAX_ACTIVE_MARKETS=2`

## Step 6: First Live-Lite Session

Do not treat the first live-lite session as a profit attempt.

It is a systems test with real exchange order placement under a very small risk envelope.

Use:

- `docs/runbooks/live_lite_rollout.md`

### What to watch in the first 15 minutes

On the UI:

- `runtimeMode = live-lite`
- live-lite warning banner is visible
- market data source is live
- execution mode is live
- allowlist and caps are visible
- no reconciliation drift
- market data remains fresh

Operationally:

- no orders or fills outside allowlist
- no unexpected order rejections after resume
- pause actually stops new placements

### Immediate abort conditions

Pause and stop the session if any of these happen:

- active reconciliation drift
- market data stale for more than 2 minutes
- unexpected fills
- orders or fills outside allowlist
- caps exceeded
- unexpected order rejection after resume
- runtime crash or unhandled exception

### Abort procedure

1. press `Pause` in the UI
2. verify no new orders appear
3. quarantine a family if needed
4. stop runtime
5. save logs and snapshots

## What Happens After The First Live-Lite Session

After the first live-lite run:

1. save artifacts
2. review logs and snapshots
3. identify any drift, stale-data, or order-flow surprises
4. decide whether to:
   - rerun with the same envelope
   - make a small fix
   - slightly widen the envelope later

Do not widen the envelope on the same day as the first live-lite session unless the run is very clean and fully understood.

## Minimal Artifact Checklist For Any Serious Run

For paper or live-lite, always save:

- `bot_run_id`
- start and end timestamps
- full runtime log
- full API log
- `Overview` screenshot
- `Risk` or `Families` screenshot
- `/api/v1/status`
- `/api/v1/metrics`
- `/api/v1/families`
- `/api/v1/orders`
- `/api/v1/fills`
- `/api/v1/risk-events`

## Short Version

If you want the shortest possible sequence:

1. create `.env.simulation`
2. run one local smoke test
3. get Polymarket credentials
4. create `.env.paper`
5. run `paper` for 2 hours
6. collect logs and snapshots
7. review the run
8. only then prepare `.env.live-lite`
9. run live-lite preflight
10. run one narrow live-lite session
