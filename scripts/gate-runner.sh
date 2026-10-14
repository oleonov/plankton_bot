#!/usr/bin/env bash
# Produces the exact-HEAD gate evidence that `deploy.sh --gate-evidence` verifies.
# Flow (docs/runbooks/live_lite_rollout.md, "Producing gate evidence"):
#   1. on the base commit: pnpm run test / pnpm run lint into $GATE_DIR/baseline-{test,lint}.log
#   2. make the change, then: scripts/gate-runner.sh gate ALLOWLIST_FILE
#   3. commit + push, then:   scripts/gate-runner.sh finalize  -> $GATE_DIR/gate-evidence.json
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO
readonly GATE_DIR="${GATE_DIR:?set GATE_DIR to a private evidence directory (mktemp -d)}"
readonly BASE_SHA="${BASE_SHA:?set BASE_SHA to the full commit the change is based on}"
readonly EXPECTED_NODE=v24.14.1
readonly EXPECTED_PNPM=10.6.1
readonly TIMEOUT_BIN=/opt/homebrew/bin/timeout

focused_dirs=(
  apps/runtime apps/runtime apps/runtime apps/runtime apps/runtime apps/runtime apps/runtime
  apps/runtime apps/runtime packages/exchange scripts packages/db apps/api
  apps/runtime apps/runtime apps/runtime apps/runtime apps/runtime apps/runtime apps/runtime
  apps/runtime apps/runtime apps/runtime apps/runtime apps/api apps/web
  apps/runtime apps/runtime
)
focused_specs=(
  src/__tests__/risk-inventory-module.test.ts
  src/modules/reconciliation/__tests__/wallet-position-sentinel.test.ts
  src/modules/inventory-auto-merge/__tests__/merge-candidate-service.test.ts
  src/modules/inventory-auto-merge/__tests__/merge-ledger-write-ahead.test.ts
  src/__tests__/startup-position-adoption.test.ts
  src/modules/track-s4/__tests__/dust-auto-close-module.test.ts
  src/__tests__/position-concentration-service.test.ts
  src/__tests__/stranded-fill-alert.test.ts
  src/__tests__/unreconciled-fill-restart-recovery.test.ts
  src/__tests__/polymarket-data-api.test.ts
  __tests__/krabs-rollback-guard.test.ts
  src/__tests__/operator-repository.test.ts
  src/__tests__/api.test.ts
  src/__tests__/wallet-order-capacity.test.ts
  src/modules/risk-inventory/__tests__/algo-risk-gate.test.ts
  src/__tests__/order-status-resolver.test.ts
  src/__tests__/order-reconciler.test.ts
  src/__tests__/import-exchange-fills.test.ts
  src/__tests__/reconciliation-module.test.ts
  src/__tests__/fill-poller-module.test.ts
  src/__tests__/exchange-absence.test.ts
  src/__tests__/stale-order-cleaner.test.ts
  src/__tests__/user-order-stream-module.test.ts
  src/__tests__/execution-module.test.ts
  src/__tests__/system-health.test.ts
  src/__tests__/components/status-bar.test.tsx
  src/modules/algo-decision/__tests__/algo-decision-module.test.ts
  src/modules/algo-decision/__tests__/decision-planner.test.ts
)
required_tags=(
  T1 T2 T3 T4 T5 T6 T7 T8 T9 T10a T10b T11 T12 T13 T13b T13d T14 T14b T15 T16 T17
  T18a T18b-core T18b-log T18c T19 T20 T21a T21b T21c T22 T23 T24 T25 T26 T27
  T28a T28b T28c T28d T28e T28f T28g T28h T28i T28j
)

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

preflight() {
  cd "$REPO"
  test "$(node --version)" = "$EXPECTED_NODE" || die "Node must be $EXPECTED_NODE"
  test "$(pnpm --version)" = "$EXPECTED_PNPM" || die "pnpm must be $EXPECTED_PNPM"
  test -x "$TIMEOUT_BIN" || die "GNU timeout is unavailable"
  test -f "$GATE_DIR/baseline-test.log" || die "baseline-test.log is missing"
  test -f "$GATE_DIR/baseline-lint.log" || die "baseline-lint.log is missing"
  rg -q 'Tasks:[[:space:]]+15 successful, 15 total' "$GATE_DIR/baseline-test.log"
  rg -q 'Tasks:[[:space:]]+9 successful, 9 total' "$GATE_DIR/baseline-lint.log"
}

repo_input_hash() { (cd "$REPO" && ./deploy.sh --print-gate-input-hash); }

validate_focused_log() {
  local log="$1" clean
  test -s "$log" && test ! -L "$log" || return 1
  clean="$(mktemp "$GATE_DIR/.focused-clean.XXXXXX")"
  if ! sed -E $'s/\x1B\[[0-9;]*[mK]//g' "$log" > "$clean"; then
    rm -f "$clean"; return 1
  fi
  if ! rg -q 'Test Files[[:space:]]+1 passed \(1\)' "$clean"; then
    rm -f "$clean"; return 1
  fi
  local summary passed total
  if ! summary="$(rg 'Tests[[:space:]]+' "$clean" | tail -1)" || test -z "$summary"; then
    rm -f "$clean"; return 1
  fi
  passed="$(printf '%s\n' "$summary" | sed -E 's/.* ([0-9]+) passed.*/\1/')"
  total="$(printf '%s\n' "$summary" | sed -E 's/.*\(([0-9]+)\).*/\1/')"
  if test "$passed" != "$total" || rg -q 'Test Files.*failed|Tests.*failed|No test files found|↓' "$clean"; then
    rm -f "$clean"; return 1
  fi
  rm -f "$clean"
  return 0
}

run_focused_index() {
  local i="$1" dir spec log stamp current_hash
  test "$i" -ge 0 && test "$i" -lt "${#focused_specs[@]}" || die "bad focused index: $i"
  dir="${focused_dirs[$i]}"; spec="${focused_specs[$i]}"
  log="$GATE_DIR/focused-$i.log"; stamp="$GATE_DIR/focused-$i.input.sha256"
  current_hash="$(repo_input_hash)"
  if test -s "$log" && test -f "$stamp" && test "$(<"$stamp")" = "$current_hash" && validate_focused_log "$log"; then
    printf 'REUSED focused-%s %s/%s\n' "$i" "$dir" "$spec"
    return
  fi
  if test "$spec" = __tests__/krabs-rollback-guard.test.ts; then
    (cd "$REPO/$dir" && "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 420s \
      pnpm exec vitest run --reporter=verbose "$spec") 2>&1 | tee "$log"
  else
    (cd "$REPO/$dir" && pnpm exec vitest run --reporter=verbose "$spec") 2>&1 | tee "$log"
  fi
  validate_focused_log "$log"
  printf '%s\n' "$current_hash" > "$stamp"
}

check_tag_census() {
  local files=() i tag source_count run_count
  for i in "${!focused_specs[@]}"; do files+=("${focused_dirs[$i]}/${focused_specs[$i]}"); done
  : > "$GATE_DIR/gate-cases.txt"
  for i in "${!focused_specs[@]}"; do
    validate_focused_log "$GATE_DIR/focused-$i.log"
    sed -E $'s/\x1B\[[0-9;]*[mK]//g' "$GATE_DIR/focused-$i.log" |
      rg '^[[:space:]]*✓ ' >> "$GATE_DIR/gate-cases.txt"
  done
  for tag in "${required_tags[@]}"; do
    source_count="$( (rg -F --no-filename "it(\"${tag} — " "${files[@]}" || true) | wc -l | tr -d ' ')"
    run_count="$( (rg -F --no-filename "${tag} — " "$GATE_DIR/gate-cases.txt" || true) | wc -l | tr -d ' ')"
    test "$source_count" -eq 1 || die "$tag source count is $source_count"
    test "$run_count" -eq 1 || die "$tag run count is $run_count"
  done
}

check_focused_identity() {
  local expected i stamp
  expected="$(repo_input_hash)"
  for i in "${!focused_specs[@]}"; do
    stamp="$GATE_DIR/focused-$i.input.sha256"
    test -f "$stamp" && test "$(<"$stamp")" = "$expected" ||
      die "focused-$i is not bound to current repository inputs"
  done
}

run_focused() {
  preflight
  local selection="${1:-all}" i
  if test "$selection" = all; then
    for i in "${!focused_specs[@]}"; do run_focused_index "$i"; done
  else
    IFS=, read -r -a indices <<< "$selection"
    for i in "${indices[@]}"; do run_focused_index "$i"; done
  fi
}

adopt_focused() {
  preflight
  local i="$1" candidate="$2" log="$GATE_DIR/focused-$1.log"
  test "$i" -ge 0 && test "$i" -lt "${#focused_specs[@]}" || die "bad focused index: $i"
  validate_focused_log "$candidate" || die "focused log is not a genuine passing Vitest log"
  cp "$candidate" "$log"
  printf '%s\n' "$(repo_input_hash)" > "$GATE_DIR/focused-$i.input.sha256"
  printf 'ADOPTED focused-%s\n' "$i"
}

check_allowlist() {
  local allowlist="$1"
  test -s "$allowlist" || die "allowlist is empty or missing"
  sed '/^[[:space:]]*$/d' "$allowlist" | LC_ALL=C sort -u > "$GATE_DIR/expected-files.txt"
  test "$(wc -l < "$GATE_DIR/expected-files.txt" | tr -d ' ')" = \
    "$(sed '/^[[:space:]]*$/d' "$allowlist" | wc -l | tr -d ' ')" || die "allowlist has duplicates"
  if rg -n '^/|(^|/)\.\.(/|$)' "$GATE_DIR/expected-files.txt"; then die "allowlist paths must be repository-relative"; fi
  {
    git diff --name-only --diff-filter=ACMR "$BASE_SHA"
    git ls-files --others --exclude-standard
  } | LC_ALL=C sort -u > "$GATE_DIR/actual-files.txt"
  test -z "$(git diff --name-only --diff-filter=D "$BASE_SHA")" || die "deleted files are forbidden"
  diff -u "$GATE_DIR/expected-files.txt" "$GATE_DIR/actual-files.txt"
  local changed_lines new_file
  changed_lines="$(git diff --numstat "$BASE_SHA" | awk '$3 !~ /__tests__|\/test\// {n += $1 + $2} END {print n+0}')"
  while IFS= read -r new_file; do
    case "$new_file" in */__tests__/*|*/test/*) continue ;; esac
    changed_lines=$((changed_lines + $(wc -l < "$new_file")))
  done < <(git ls-files --others --exclude-standard)
  test "$changed_lines" -le 1500 || die "approved non-test diff cap exceeded: $changed_lines > 1500"
  printf 'SCOPE_LINES %s/1500\n' "$changed_lines"
  if git diff --unified=0 "$BASE_SHA" -- '*.ts' | rg '^\+.*((it|test|describe)\.(skip|todo)|skipIf)'; then
    die "new skip/todo is forbidden"
  fi
}

write_census() {
  python3 - "$GATE_DIR/baseline-test.log" "$GATE_DIR/post-test.log" "$GATE_DIR/test-census.json" <<'PY'
import json,re,sys
ansi=re.compile(r"\x1b\[[0-9;]*[mK]")
line_re=re.compile(r"(@krabs/[^:]+):test:.*?(Test Files|Tests)\s+(?P<passed>\d+) passed(?:\s+\|\s+(?P<failed>\d+) failed)?(?:\s+\|\s+(?P<skipped>\d+) skipped)?\s+\((?P<total>\d+)\)")
def parse(path):
 out={}
 for raw in open(path,encoding="utf-8",errors="replace"):
  m=line_re.search(ansi.sub("",raw))
  if not m: continue
  package=m.group(1); kind="files" if m.group(2)=="Test Files" else "tests"
  assert kind not in out.setdefault(package,{}),(path,package,kind)
  cell={key:int(m.group(key) or 0) for key in ("passed","failed","skipped","total")}
  assert cell["total"]==cell["passed"]+cell["failed"]+cell["skipped"],cell
  out[package][kind]=cell
 assert out and all(set(value)=={"files","tests"} for value in out.values()),(path,out)
 return out
baseline,post=parse(sys.argv[1]),parse(sys.argv[2])
assert set(baseline)==set(post),(set(baseline),set(post))
for package in baseline:
 for kind in ("files","tests"):
  before,after=baseline[package][kind],post[package][kind]
  assert before["failed"]==after["failed"]==0,(package,kind,before,after)
  assert before["skipped"]==after["skipped"],(package,kind,before,after)
  assert after["passed"]>=before["passed"] and after["total"]>=before["total"],(package,kind,before,after)
open(sys.argv[3],"w").write(json.dumps({"baseline":baseline,"post":post},sort_keys=True)+"\n")
PY
}

check_lint() {
  python3 - "$GATE_DIR/baseline-lint.log" "$GATE_DIR/post-lint.log" <<'PY'
import re,sys
ansi=re.compile(r"\x1b\[[0-9;]*[mK]")
pkg_re=re.compile(r"(?m)^(@krabs/[^:\n]+):lint:")
count_re=re.compile(r"(?m)^(@krabs/[^:]+):lint:.*?(\d+) problems? \((\d+) errors?, (\d+) warnings?\)$")
def parse(path):
 text=ansi.sub("",open(path,encoding="utf-8",errors="replace").read())
 out={package:(0,0,0) for package in pkg_re.findall(text)}; seen=set()
 assert out,path
 for m in count_re.finditer(text):
  package=m.group(1); assert package in out and package not in seen,(path,package); seen.add(package)
  out[package]=tuple(map(int,m.groups()[1:]))
 return out
before,after=parse(sys.argv[1]),parse(sys.argv[2])
assert set(before)==set(after),(set(before),set(after))
assert all(before[p][1]==after[p][1]==0 and after[p][2]<=before[p][2] for p in before),(before,after)
PY
}

run_gate() {
  local allowlist="$1" hash hash_before completed
  preflight
  rm -f "$GATE_DIR/gate-summary.json" "$GATE_DIR/gate-evidence.json"
  run_focused all
  check_tag_census
  check_focused_identity
  check_allowlist "$allowlist"
  hash_before="$(repo_input_hash)"
  bash -n deploy.sh
  bash -n scripts/krabs-rollback-guard.sh
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 360s pnpm run typecheck 2>&1 | tee "$GATE_DIR/typecheck.log"
  rg -q 'Tasks:[[:space:]]+15 successful, 15 total' "$GATE_DIR/typecheck.log"
  ! rg -q 'error TS' "$GATE_DIR/typecheck.log"
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 360s pnpm run build 2>&1 | tee "$GATE_DIR/build.log"
  rg -q 'Tasks:[[:space:]]+9 successful, 9 total' "$GATE_DIR/build.log"
  ! rg -q 'error TS' "$GATE_DIR/build.log"
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 1500s pnpm run test 2>&1 | tee "$GATE_DIR/post-test.log"
  rg -q 'Tasks:[[:space:]]+15 successful, 15 total' "$GATE_DIR/post-test.log"
  write_census
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 600s pnpm run lint 2>&1 | tee "$GATE_DIR/post-lint.log"
  rg -q 'Tasks:[[:space:]]+9 successful, 9 total' "$GATE_DIR/post-lint.log"
  check_lint
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 300s pnpm exec prettier --check . 2>&1 | tee "$GATE_DIR/prettier.log"
  hash="$(./deploy.sh --print-gate-input-hash)"; test "${#hash}" -eq 64
  test "$hash" = "$hash_before" || die "repository inputs changed while the gate was running"
  completed="$(date +%s)"
  python3 - "$GATE_DIR/gate-summary.json" "$completed" "$hash" <<'PY'
import json,pathlib,sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({"schemaVersion":1,"status":"passed","gateCompletedAtEpoch":int(sys.argv[2]),"repoInputHash":sys.argv[3],"requiredSteps":["focused","allowlist","bash","typecheck","build","test","census","lint","prettier"]},sort_keys=True)+"\n")
PY
  printf 'GATE_PASSED %s\n' "$hash"
}

finalize() {
  preflight
  test "$(git branch --show-current)" = master || die "finalize requires master"
  test -z "$(git status --porcelain)" || die "finalize requires a completely clean tree"
  local head origin hash
  head="$(git rev-parse HEAD)"; origin="$(git rev-parse origin/master)"
  test "$head" = "$origin" || die "HEAD must equal origin/master after push"
  hash="$(./deploy.sh --print-gate-input-hash)"
  python3 - "$GATE_DIR" "$head" "$origin" "$hash" "$EXPECTED_NODE" "$EXPECTED_PNPM" <<'PY'
import hashlib,json,pathlib,re,sys
gate=pathlib.Path(sys.argv[1]).resolve(); head,origin,tree,node,pnpm=sys.argv[2:]
summary=json.loads((gate/"gate-summary.json").read_text())
assert summary["repoInputHash"]==tree
names=["baseline-test.log","baseline-lint.log","gate-cases.txt","typecheck.log","build.log","post-test.log","post-lint.log","prettier.log","gate-summary.json","test-census.json"]
focused=sorted((p.name for p in gate.glob("focused-*.log")),key=lambda n:int(re.fullmatch(r"focused-(\d+)\.log",n).group(1)))
assert focused==[f"focused-{i}.log" for i in range(28)],focused
names+=focused
for name in names:
 p=gate/name
 assert p.is_file() and not p.is_symlink() and p.stat().st_size,name
logs=[{"path":str((gate/name).resolve()),"sha256":hashlib.sha256((gate/name).read_bytes()).hexdigest()} for name in names]
evidence={"schemaVersion":1,"status":"passed","gateCompletedAtEpoch":summary["gateCompletedAtEpoch"],"branch":"master","headSha":head,"originSha":origin,"repoInputHash":tree,"nodeVersion":node,"pnpmVersion":pnpm,"gateDir":str(gate),"requiredSteps":summary["requiredSteps"],"logs":logs}
(gate/"gate-evidence.json").write_text(json.dumps(evidence,sort_keys=True)+"\n")
PY
  ./deploy.sh --verify-gate-evidence-only "$GATE_DIR/gate-evidence.json"
  printf 'EVIDENCE_READY %s\n' "$GATE_DIR/gate-evidence.json"
}

usage() {
  printf '%s\n' \
    'usage:' \
    '  gate-runner.sh focused [all|comma-separated-indices]' \
    '  gate-runner.sh adopt-focused INDEX LOG_PATH' \
    '  gate-runner.sh gate ALLOWLIST_FILE' \
    '  gate-runner.sh finalize'
}

case "${1:-}" in
  focused) test "$#" -le 2 || die "focused takes at most one selection"; run_focused "${2:-all}" ;;
  adopt-focused) test "$#" -eq 3 || die "adopt-focused requires INDEX LOG_PATH"; adopt_focused "$2" "$3" ;;
  gate) test "$#" -eq 2 || die "gate requires ALLOWLIST_FILE"; run_gate "$2" ;;
  finalize) test "$#" -eq 1 || die "finalize takes no arguments"; finalize ;;
  *) usage; exit 2 ;;
esac
