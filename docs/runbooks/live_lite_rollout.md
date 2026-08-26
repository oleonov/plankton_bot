# Live-Lite Session Procedure

## Prerequisites

- [ ] Preflight passed (see `live_lite_preflight.md`)
- [ ] Operator present and monitoring
- [ ] Web dashboard open
- [ ] Terminal with live logs open

## Startup Checklist

- [ ] All env vars set per preflight
- [ ] DB path confirmed
- [ ] Logs location known
- [ ] Web dashboard accessible
- [ ] Confirm live-lite banner visible in StatusBar

## First 15 Minutes

- [ ] Signals are being produced for allowlisted families only
- [ ] Orders are being placed on exchange (check exchange dashboard)
- [ ] Fills are arriving and positions are opening
- [ ] Reconciliation runs cleanly (no drift)
- [ ] Caps holding: check Overview envelope display
- [ ] No unexpected rejections in logs

## First Hour

- [ ] Positions match expectations (size, direction, event slug within include rules)
- [ ] No reconciliation drift detected
- [ ] Caps not exceeded
- [ ] No unexpected ERROR-level log entries
- [ ] Market data remains FRESH

## Abort Conditions

- Market data STALE for >2 minutes
- Reconciliation drift detected (RECON DRIFT badge)
- Unexpected fills from non-allowlisted families
- Cap exceeded (should not happen — indicates enforcement failure)
- Any unexpected order rejection after resume
- Runtime crash or unhandled exception

## Abort Procedure

1. **PAUSE** via web UI → verify "PAUSED" badge appears
2. Verify no new orders placed after pause
3. If needed: quarantine all families via operator commands
4. Review logs and positions before taking further action

## Recovery Steps

1. Stop or keep paused per incident severity
2. Review DB state: positions, orders, fills
3. Determine root cause of abort
4. Document findings

## Post-Run Review

- [ ] Compare positions against expectations
- [ ] Review all fills for correctness
- [ ] Check PnL matches manual calculation
- [ ] Review any rejected orders and reasons
- [ ] Document any issues found

## Artifacts to Save

- [ ] `bot_run_id` from this session
- [ ] Timestamp/session window (start → end)
- [ ] Active allowlist + caps at time of session
- [ ] Screenshot of Overview page
- [ ] Screenshot of Risk/Families page
- [ ] Relevant log excerpt (errors, warnings, rejections)
- [ ] Final `/api/v1/status` JSON snapshot

## #143/#144 Release, Selective Rollback, and Monitoring

Run from the checkout root. Release requires the verified exact-HEAD gate evidence; never replace it
by rerunning unchanged local suites.

```bash
set -euo pipefail
test "$(git branch --show-current)" = master
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
./deploy.sh --verify-gate-evidence-only "$GATE_EVIDENCE"
./deploy.sh --gate-evidence "$GATE_EVIDENCE"
```

If a release is fail-stopped in `target_stopped_rearbitrate` and the stopped target itself must be
replaced by a newer fix, use the explicit supersede mode. Bind the command to the exact failed
target SHA from `deploy-recovery.json`; the new checkout still requires its own exact-HEAD gate
evidence:

```bash
FAILED_TARGET_SHA="${FAILED_TARGET_SHA:?}"
test "$(git branch --show-current)" = master
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
./deploy.sh --verify-gate-evidence-only "$GATE_EVIDENCE"
./deploy.sh --supersede-stopped-recovery "$FAILED_TARGET_SHA" --gate-evidence "$GATE_EVIDENCE"
```

Supersede is release-only and fails before pulling or changing deployment state unless recovery is
exactly `target_stopped_rearbitrate`, metadata is still at the previous deploy version, the marker
owns the same recovery ID, the runtime environment hash is unchanged, and both saved trading
containers are stopped with restart `no` and the failed SHA/image. The runtime may have no network
or only the saved default; the manager may retain any recovery-time subset of that default plus its
Compose-owned internal `manager-net`. Any foreign network fails closed, and every retained approved
network is fenced before rebinding. No rollback state or marker may coexist. The single running
`krabs-api` container must have the same failed SHA/image and saved network. It preserves the recovery ID,
baseline, pre-deploy pause intent, previous version, and saved network; then it fences the stopped
targets, replaces the API, reruns the migration gates, health/cutoff proof, final command
arbitration, and normal metadata commit for the new SHA. Never edit or remove recovery, marker, or
metadata files manually. If the supersede process stops after the recovery has been rebound to the
new SHA, resume it with the ordinary exact-SHA `--gate-evidence` command.

Selective rollback is strict: make a new rollback commit from a clean `master`, apply the aggregate
reverse patch, then restore exactly the nine protected operational paths and four delivery docs
from the release. Push it, wait for CI on its exact SHA, and prove the boundary before ownership:

```bash
BASE_SHA="${ROLLBACK_BASE_SHA:?}"; RELEASE_SHA="${RELEASE_SHA:?}"
test "$(git branch --show-current)" = master
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
git diff --binary "$BASE_SHA" "$RELEASE_SHA" | git apply -R --index
git restore --source "$RELEASE_SHA" --staged --worktree -- deploy.sh scripts/krabs-rollback-guard.sh scripts/krabs-order-status-migration-gate.sh scripts/__tests__/krabs-order-status-migration-gate.test.ts apps/api/src/routes/actions.ts packages/db/src/repositories/operator-command-repository.ts scripts/__tests__/krabs-rollback-guard.test.ts apps/api/src/__tests__/api.test.ts packages/db/src/__tests__/operator-repository.test.ts CHANGELOG.md docs/ROADMAP.md docs/plans/2026-08-11-swallowed-fill-recovery-and-multirow-token.md docs/runbooks/live_lite_rollout.md
# Commit and push this selective rollback; wait for CI before continuing.
./deploy.sh --verify-rollback-boundary "$BASE_SHA" "$RELEASE_SHA"
TARGET_SHA="$(git rev-parse HEAD)"
STATUS="$(ssh -o BatchMode=yes -o ConnectTimeout=10 root@your.server.ip krabs-rollback-guard begin "$TARGET_SHA" && ssh -o BatchMode=yes -o ConnectTimeout=10 root@your.server.ip krabs-rollback-guard status)"
STATUS_JSON="$(printf '%s\n' "$STATUS" | sed -n 's/^ROLLBACK_STATUS //p')"
test "$(printf '%s\n' "$STATUS_JSON" | wc -l | tr -d ' ')" -eq 1
ROLLBACK_STATE_ID="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,re,sys; d=json.load(sys.stdin); required={"schemaVersion","rollbackStateId","phase","preRollbackPaused","startedAt","originalSha","targetSha","baselineCommandHighWater","multirowCount"}; assert set(d)==required and d["phase"]=="prepared" and d["targetSha"]==sys.argv[1] and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",d["rollbackStateId"]); print(d["rollbackStateId"])' "$TARGET_SHA")"
./deploy.sh --rollback-state-id "$ROLLBACK_STATE_ID"
RECEIPT="$(ssh -o BatchMode=yes -o ConnectTimeout=10 root@your.server.ip krabs-rollback-guard finalize "$TARGET_SHA")"
printf '%s\n' "$RECEIPT" | sed -n 's/^ROLLBACK_RECEIPT //p' | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["targetSha"]==sys.argv[1] and isinstance(d["effectivePaused"],bool) and isinstance(d["finalOperatorCommandHighWater"],int)' "$TARGET_SHA"
```

`finalize` exit `0` requires one matching `ROLLBACK_RECEIPT`; use its `effectivePaused` and
`finalOperatorCommandHighWater` as the monitoring baseline. Exit `20` means the multi-row incident
is owned: keep the bot paused, leave the rollback marker/state and enabled guard timer in place, and
do not start T+0. Any other nonzero is fail-closed. `arming`, `prepared`, `deploying`, and `blocked`
are marker-fenced: Resume is rejected; Pause remains available. Never remove a marker, state, or
system-owned command manually.

For release mode, the controller stops API/runtime-manager/runtime and takes one root-only,
read-only snapshot for migrations 101 through 103. It then starts the target API so it runs migrations
and proves the same snapshot before either runtime service starts. Accept `migration101` only when
its marker is exactly once, candidate count/hash match, every candidate is now `filled` with audit
fields preserved, and no noncandidate order changed.

Accept sibling field `migration102` only when its marker is exactly once, the intent table has the
canonical columns, normalized CHECK constraints, UNIQUE/primary-key constraints and exact named
indexes, and its ordered row count/hash did not change across API bootstrap. Before first apply the
table may be absent or canonical and empty; a previously applied marker requires the canonical table
but permits preserved rows. Marker/table mismatches, an unmarked nonempty table, schema drift, or row
mutation are fail-stopped. Selective rollback retains this additive table and emits no fabricated
`migration102` proof; do not drop or manually repair the table, marker, runtime, or ledger.

Accept sibling field `migration103` under the same stopped-ledger rules. Its marker must appear
exactly once after bootstrap, and `bounce_ask_capture_reprice_intents` must retain the canonical
ordered columns, replacement/status/JSON CHECKs, primary and UNIQUE constraints, named status/root
indexes, and the UNIQUE partial nonterminal-position index. Its ordered row count/hash must not
change. Before first apply the table may be absent or canonical and empty; a previous marker requires
the canonical table and permits preserved rows. Old shapes, malformed proof constraints,
marker/table mismatches, unmarked rows, or row mutation are fail-stopped. Selective rollback retains
the additive table and emits no fabricated `migration103` proof.

For either mode, accept `DEPLOY_RECEIPT` only when its embedded receipt exactly matches the durable
metadata: SHA, immutable digest, recovery state ID, previous/deploy versions, pre-pause provenance,
locked run/API identity, final command high-water, and operator-pause override. `effectivePaused`
must equal the recorded arbitration result. A pre-deploy or newer operator pause remains authoritative.

Start the observation epoch only after the new runtime is ready. Run the plan §9.2 evidence probe at
T+0, T+10, T+20, and T+30: its markers must be `T0`, `T10`, `T20`, and `T30`; T10/T20/T30 must land
at 600–720, 1200–1320, and 1800–1920 seconds from the epoch, with waits no longer than 60 seconds.
Each checkpoint requires the receipt SHA/version, resolved pause state, new run/instance and fresh
heartbeat; running mode also requires fresh post-run and post-deploy market-data and reconciliation.
It also requires four healthy containers, unchanged restart/OOM/StartedAt after T0, disk <80%, each
container memory <90%, no new error/fatal logs, zero multi-row rows, no target alerts, and no
unreconciled fill aged 900000 ms or more. Stop promotion on any anomaly; make the minimal correction,
commit/push/CI/deploy it, and restart the observation at T+0.
