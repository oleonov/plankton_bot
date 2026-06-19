# First Launch Guide

This guide is the practical next step after Phase 15.

There are no new large implementation phases left in the current v1 plan. The next work is operational:

1. local boot check (runtime starts **paused** — no real orders are placed)
2. `live-lite` preflight
3. first narrow `live-lite` session
4. post-run review and small fixes if needed

> **Runtime modes:** `live-lite` is the only supported runtime/operator profile. `simulation` and `paper` are retired as runnable modes. Historical `simulation`/`paper` rows may remain in the DB and the simulation gateway classes remain as test doubles, but the runtime, API, and operator switch paths only accept `live-lite`.

Use this file as the "start here" guide. For the detailed live-lite procedures, also use:

- `docs/runbooks/live_lite_preflight.md`
- `docs/runbooks/live_lite_rollout.md`

## What You Need Before The First Run

### Local API key

You need one local API key for the operator API and web UI:

- `KRABS_API_KEY`

This is not a Polymarket key. It is just a local bearer token for the API/UI.

Use a long random string.

### Polymarket CLOB credentials

You need real Polymarket credentials to run `live-lite`:

- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_PASSPHRASE`
- `POLY_PRIVATE_KEY`

The runtime always starts **paused**, so the first boot places no orders, but the live-lite client is still constructed at startup and needs these credentials.

### SQLite files

DB files live under `./apps/runtime/data/`. The active live-lite ledger is:

- `./apps/runtime/data/ledger-live-lite.db`

Historical `krabs-sim.db` / `krabs-paper.db` files may still exist from earlier runs; they are not used by the live-lite runtime.

### One important note about `.env.example`

`RUNTIME_MODE` is optional — the profile is read from `control.db`. Only `live-lite` is supported as a runtime/operator profile. Do not set `simulation` or `paper`; they are rejected at startup.

### Trading rules at startup

There is no YAML config for trading rules. Two DB-backed rule sets cover everything the old `family_rules.yaml` used to express (selection rules + algo rules):

- **Selection rules** (`control.db` → `selection_rules`): which event slugs the scanner admits. Seeded at first boot via migration 037 with `bitcoin-`, `ethereum-`, `elon-musk-` prefixes per profile.
- **Algo rules** (`control.db` → `algo_rules`): decision / size / redeem logic. Seeded with canonical 06-spec defaults at first boot.

Both rule sets are editable via the web UI (`/selection-rules`) or REST API; runtime hot-reloads on every mutation. See `docs/runbooks/selection_rules_operations.md` for details.

`INITIAL_BALANCE_USDC` is ignored in live-lite mode (the real Polymarket balance is used).

## Recommended Files To Create

Create the local env file in the repo root:

- `.env.live-lite`

All `.env*` files (except `.env.example`) are gitignored.
Before each run, copy it into `.env`.

Example:

```bash
cp .env.live-lite .env
```

Both `@krabs/runtime` and `@krabs/api` read the same `.env`.

## Env Template: Live-Lite

```env
RUNTIME_MODE=live-lite
LOG_LEVEL=info
DB_PATH=./apps/runtime/data/krabs.db
KRABS_API_KEY=replace-with-a-long-random-string
KRABS_API_PORT=3100

POLY_API_KEY=replace
POLY_API_SECRET=replace
POLY_PASSPHRASE=replace

LIVE_LITE_CONFIRM=true
LIVE_LITE_MAX_OPEN_VALUE_USDC=50
LIVE_LITE_MAX_ORDER_USDC=10
LIVE_LITE_MAX_ACTIVE_MARKETS=2
```

> `DB_PATH` is the base path; the filename is replaced with `control.db`, and the ledger is derived as `ledger-live-lite.db` in the same directory.

## Step 1: First Local Boot Check

### Goal

This run is not for performance or strategy validation.

It is only to confirm that:

- runtime starts
- API starts
- web UI loads
- auth works
- SSE works
- pause/resume is visible and behaves correctly

The runtime always starts **paused**, so this boot check places no orders even though it runs `live-lite`.

### Commands

Prepare directories:

```bash
mkdir -p apps/runtime/data logs snapshots
```

Select the env:

```bash
cp .env.live-lite .env
```

Build once:

```bash
pnpm build
```

Start runtime in terminal 1:

```bash
pnpm --filter @krabs/runtime start 2>&1 | tee logs/runtime-$(date +%Y%m%d-%H%M%S).log
```

Start API in terminal 2:

```bash
pnpm --filter @krabs/api start 2>&1 | tee logs/api-$(date +%Y%m%d-%H%M%S).log
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

- `runtimeMode = live-lite`
- the runtime is **paused**
- SSE is connected
- the page updates without auth errors

Also check:

- `Families` page loads
- `Risk` page loads
- `Pause` changes visible state
- `Resume` restores visible state

> Keep the runtime **paused** during this boot check. Do not resume until live-lite preflight is clean — resuming places real orders.

### What to save after the boot check

Set a local shell variable for snapshots:

```bash
API_KEY='replace-with-the-same-KRABS_API_KEY'
```

Save a status snapshot:

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:3100/api/v1/status \
  > snapshots/status-boot.json
```

Also save:

- runtime log file from `logs/`
- API log file from `logs/`
- screenshot of `Overview`
- screenshot of `Risk`

### Stop conditions for the boot check

Stop and fix before continuing if any of these happen:

- runtime crashes
- API crashes
- UI cannot authenticate
- SSE never connects
- pause/resume does not change visible state

## Step 2: Live-Lite Preflight

Do not resume the runtime until preflight is clean.

Use:

- `docs/runbooks/live_lite_preflight.md`

The purpose of preflight is to verify:

- real credentials are present
- selection rules are seeded for the live-lite profile
- caps are defined
- current DB state does not violate the live-lite envelope
- runtime either starts cleanly or starts paused with clear violations

### Session 1 envelope

Use the narrow session-1 envelope:

- selection rules for `live-lite` profile restricted to one prefix (e.g. `bitcoin-`)
- `LIVE_LITE_MAX_OPEN_VALUE_USDC=50`
- `LIVE_LITE_MAX_ORDER_USDC=10`
- `LIVE_LITE_MAX_ACTIVE_MARKETS=2`

## Step 3: First Live-Lite Session

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

- no orders or fills on event slugs that don't match any include rule
- no unexpected order rejections after resume
- pause actually stops new placements

### Immediate abort conditions

Pause and stop the session if any of these happen:

- active reconciliation drift
- market data stale for more than 2 minutes
- unexpected fills
- orders or fills on excluded event slugs
- caps exceeded
- unexpected order rejection after resume
- runtime crash or unhandled exception

### Abort procedure

1. press `Pause` in the UI
2. verify no new orders appear
3. disable the offending selection rule if a narrow fix is enough
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

For any live-lite run, always save:

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

1. create `.env.live-lite`
2. run one local boot check (stays paused)
3. confirm credentials and caps
4. run live-lite preflight
5. run one narrow live-lite session
6. collect logs and snapshots
7. review the run
