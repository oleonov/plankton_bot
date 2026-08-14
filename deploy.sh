#!/usr/bin/env bash
set -euo pipefail

readonly DEPLOY_SECONDS=2640
readonly REMOTE_SECONDS=2580
readonly SERVER_USER=root SERVER_HOST=your.server.ip SERVER_PATH=/opt/krabs
readonly IMAGE=ghcr.io/oleonov/krabs
readonly RETAINED=(deploy.sh scripts/krabs-rollback-guard.sh scripts/krabs-order-status-migration-gate.sh apps/api/src/routes/actions.ts packages/db/src/repositories/operator-command-repository.ts scripts/__tests__/krabs-rollback-guard.test.ts apps/api/src/__tests__/api.test.ts packages/db/src/__tests__/operator-repository.test.ts CHANGELOG.md docs/ROADMAP.md docs/plans/2026-08-11-swallowed-fill-recovery-and-multirow-token.md docs/runbooks/live_lite_rollout.md)

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
test_mode() { [[ "${KRABS_DEPLOY_TEST_MODE:-}" == 1 ]]; }
run() { if test_mode; then "${KRABS_DEPLOY_ADAPTER:?test adapter required}" "$@"; else "$@"; fi; }
atomic() { local p="$1" v="$2" t; t="${p}.tmp.$$"; umask 077; printf '%s\n' "$v" >"$t"; mv -f "$t" "$p"; }
remote_root() { if test_mode && [[ -n "${KRABS_DEPLOY_TEST_REMOTE_ROOT:-}" ]]; then printf '%s\n' "$KRABS_DEPLOY_TEST_REMOTE_ROOT"; else printf '%s\n' "$SERVER_PATH"; fi; }

verify_rollback_boundary() {
  local base="$1" release="$2" head path base_blob release_blob head_blob restored=false
  [[ -z "$(git status --porcelain)" ]] || die 'rollback boundary requires tracked, indexed, and untracked cleanliness'
  head="$(git rev-parse HEAD)"
  git merge-base --is-ancestor "$base" "$release" || die 'base is not an ancestor of release'
  git merge-base --is-ancestor "$release" "$head" || die 'release is not an ancestor of rollback head'
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    base_blob="$(git cat-file -e "$base:$path" 2>/dev/null && git rev-parse "$base:$path" || true)"
    release_blob="$(git cat-file -e "$release:$path" 2>/dev/null && git rev-parse "$release:$path" || true)"
    head_blob="$(git cat-file -e "$head:$path" 2>/dev/null && git rev-parse "$head:$path" || true)"
    if [[ " ${RETAINED[*]} " == *" $path "* ]]; then
      [[ -n "$release_blob" && "$head_blob" == "$release_blob" ]] || die "retained release blob changed: $path"
    elif [[ "$head_blob" != "$base_blob" ]]; then
      die "non-retained release blob was not restored: $path"
    else
      restored=true
    fi
  done < <(git diff --name-only "$base" "$release")
  while IFS= read -r path; do
    [[ -z "$path" || " ${RETAINED[*]} " == *" $path "* ]] && continue
    git diff --name-only "$base" "$release" -- "$path" | grep -qx "$path" || die "rollback contains extra path: $path"
  done < <(git diff --name-only "$release" "$head")
  [[ "$restored" == true ]] || die 'rollback boundary requires a restored non-retained release path'
  printf 'ROLLBACK_BOUNDARY_OK %s %s\n' "$base" "$release"
}

gate_hash() {
  python3 - <<'PY'
import hashlib,os,stat,subprocess,sys

def git(*args):
    return subprocess.check_output(('git', *args))

index = {}
for entry in git('ls-files', '-s', '-z').split(b'\0'):
    if entry:
        header,path = entry.split(b'\t', 1)
        mode,object_id,_stage = header.split(b' ', 2)
        index[path] = (mode, object_id)

h = hashlib.sha256()
for path in sorted(path for path in git('ls-files', '-co', '--exclude-standard', '-z').split(b'\0') if path):
    mode,object_id = index.get(path, (None, None))
    h.update(path + b'\0')
    if mode == b'160000':
        h.update(b'gitlink:' + mode + b':' + object_id + b'\0')
        continue
    try:
        st = os.lstat(path)
    except OSError as error:
        raise SystemExit(f'cannot hash gate input {os.fsdecode(path)!r}: {error}')
    if stat.S_ISLNK(st.st_mode):
        h.update(os.fsencode(os.readlink(path)) + b'\0')
    elif stat.S_ISREG(st.st_mode):
        with open(path, 'rb') as file:
            h.update(file.read() + b'\0')
    else:
        raise SystemExit(f'unsupported gate input {os.fsdecode(path)!r}: not a regular file or symlink')
print(h.hexdigest())
PY
}
verify_gate() {
  local evidence="$1" head hash
  [[ "$(git branch --show-current)" == master ]] || die 'gate evidence requires master'
  git diff --quiet && git diff --cached --quiet || die 'gate evidence requires a clean tree'
  head="$(git rev-parse HEAD)"; hash="$(gate_hash)"
  python3 - "$evidence" "$head" "$(git rev-parse origin/master)" "$hash" "$(node --version)" "$(pnpm --version)" <<'PY'
import hashlib,json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]).resolve(); d=json.loads(p.read_text())
required_names={'baseline-test.log','baseline-lint.log','gate-cases.txt','typecheck.log','build.log','post-test.log','post-lint.log','prettier.log','gate-summary.json','test-census.json'}
assert d.get('schemaVersion')==1 and d.get('status')=='passed' and isinstance(d.get('gateCompletedAtEpoch'),int) and d['gateCompletedAtEpoch']>=0 and d.get('branch')=='master'
assert d['headSha']==sys.argv[2]==sys.argv[3] and d['originSha']==sys.argv[3] and d['repoInputHash']==sys.argv[4] and d['nodeVersion']==sys.argv[5] and d['pnpmVersion']==sys.argv[6]
assert d.get('requiredSteps')==['focused','allowlist','bash','typecheck','build','test','census','lint','prettier'] and isinstance(d.get('logs'),list)
seen=set()
for item in d['logs']:
 q=pathlib.Path(item['path']); assert (q.name in required_names or re.fullmatch(r'focused-\d+\.log',q.name)) and q.name not in seen and not q.is_symlink(); q=q.resolve(strict=True); assert q.parent==p.parent and q.is_file() and q.stat().st_size and hashlib.sha256(q.read_bytes()).hexdigest()==item['sha256']; seen.add(q.name)
focused=sorted(name for name in seen if re.fullmatch(r'focused-\d+\.log',name))
assert seen==required_names|set(focused) and focused
logs={x['path'].rsplit('/',1)[-1]:pathlib.Path(x['path']).read_text(errors='replace') for x in d['logs']}
clean=lambda s:re.sub(r'\x1b\[[0-9;]*[mK]','',s)
for log in (clean(logs[name]) for name in focused):
 assert re.search(r'Test Files\s+1 passed \(1\)',log) and not re.search(r'Test Files.*failed|Tests.*failed|No test files found|↓',log)
 summary=re.findall(r'Tests\s+.*',log); assert summary; m=re.search(r'(\d+) passed.*\((\d+)\)',summary[-1]); assert m and m.group(1)==m.group(2)
for name,count in (('typecheck.log',15),('build.log',9),('post-test.log',15),('baseline-lint.log',9),('post-lint.log',9)):
 assert re.search(rf'Tasks:\s+{count} successful, {count} total',clean(logs[name])) and 'error TS' not in logs[name]
assert clean(logs['prettier.log']).rstrip().endswith('All matched files use Prettier code style!')
tags=('T1 T2 T3 T4 T5 T6 T7 T8 T9 T10a T10b T11 T12 T13 T13b T13d T14 T14b T15 T16 T17 T18a T18b-core T18b-log T18c T19 T20 T21a T21b T21c T22 T23 T24 T25 T26 T27 T28a T28b T28c T28d T28e T28f T28g T28h T28i').split()
assert all(len(re.findall(rf'(?m){re.escape(tag)} — ',logs['gate-cases.txt']))==1 for tag in tags)
summary=json.loads(logs['gate-summary.json']); assert summary=={'schemaVersion':1,'status':'passed','gateCompletedAtEpoch':d['gateCompletedAtEpoch'],'repoInputHash':sys.argv[4],'requiredSteps':d['requiredSteps']}
census=json.loads(logs['test-census.json']); assert set(census)=={'baseline','post'} and set(census['baseline'])==set(census['post'])
line_re=re.compile(r'(@krabs/[^:]+):test:.*?(Test Files|Tests)\s+(?P<passed>\d+) passed(?:\s+\|\s+(?P<failed>\d+) failed)?(?:\s+\|\s+(?P<skipped>\d+) skipped)?\s+\((?P<total>\d+)\)')
def parsed_census(log):
 out={}
 for match in line_re.finditer(clean(log)):
  package,kind=match.group(1),('files' if match.group(2)=='Test Files' else 'tests')
  assert kind not in out.setdefault(package,{})
  out[package][kind]={key:int(match.group(key) or 0) for key in ('passed','failed','skipped','total')}
 assert out and all(set(value)=={'files','tests'} for value in out.values()),out
 assert all(cell['total']==cell['passed']+cell['failed']+cell['skipped'] for value in out.values() for cell in value.values()),out
 return out
assert parsed_census(logs['baseline-test.log'])==census['baseline'] and parsed_census(logs['post-test.log'])==census['post']
for package in census['baseline']:
 for kind in ('files','tests'):
  before,after=census['baseline'][package][kind],census['post'][package][kind]; assert set(before)==set(after)=={'passed','failed','skipped','total'} and before['failed']==after['failed']==0 and before['skipped']==after['skipped'] and after['passed']>=before['passed'] and after['total']>=before['total']
lint_package_re=re.compile(r'(?m)^(@krabs/[^:\n]+):lint:')
lint_count_re=re.compile(r'(?m)^(@krabs/[^:]+):lint:.*?(\d+) problems? \((\d+) errors?, (\d+) warnings?\)$')
def parsed_lint(log):
 cleaned=clean(log); packages=set(lint_package_re.findall(cleaned)); assert packages
 out={package:(0,0,0) for package in packages}; seen=set()
 for match in lint_count_re.finditer(cleaned):
  package=match.group(1); assert package in out and package not in seen; seen.add(package)
  out[package]=(int(match.group(2)),int(match.group(3)),int(match.group(4)))
 return out
before_lint,after_lint=parsed_lint(logs['baseline-lint.log']),parsed_lint(logs['post-lint.log']); assert set(before_lint)==set(after_lint)
assert all(before_lint[package][1]==after_lint[package][1]==0 and after_lint[package][2]<=before_lint[package][2] for package in before_lint)
PY
  printf 'GATE_EVIDENCE_OK %s %s\n' "$head" "$hash"
}

deploy_paths() {
  if test_mode; then
    CONFIG_DIR="${KRABS_DEPLOY_CONFIG_DIR:?}"; GUARD="${KRABS_DEPLOY_GUARD:?}"; LOCK="${KRABS_DEPLOY_LOCK_PATH:?}"
    DOCKER="${KRABS_DEPLOY_DOCKER:-docker}"; FLOCK="${KRABS_DEPLOY_FLOCK:-flock}"; TIMEOUT="${KRABS_DEPLOY_TIMEOUT:-timeout}"
  else
    CONFIG_DIR=/opt/krabs/config; GUARD="${KRABS_REMOTE_GUARD:-/usr/local/sbin/krabs-rollback-guard}"; LOCK=/var/lock/krabs-deploy.lock
    DOCKER=/usr/bin/docker; FLOCK=/usr/bin/flock; TIMEOUT=/usr/bin/timeout
  fi
  RECOVERY="$CONFIG_DIR/deploy-recovery.json"; META="$CONFIG_DIR/deploy-meta.json"; MARKER="$CONFIG_DIR/deploy-in-progress.json"
  ORDER_STATUS_GATE="${KRABS_ORDER_STATUS_GATE:-scripts/krabs-order-status-migration-gate.sh}"; ORDER_STATUS_GATE_SHA256="${KRABS_ORDER_STATUS_GATE_SHA256:-$(sha256sum "$ORDER_STATUS_GATE" | awk '{print $1}')}"; ORDER_STATUS_SNAPSHOT="$CONFIG_DIR/order-status-migration-101-${KRABS_REMOTE_SHA:-$(git rev-parse HEAD)}.json"
  ROLLBACK_OPERATION_LOCK="$(dirname "${KRABS_ROLLBACK_STATE_PATH:-/var/lib/krabs-rollback-guard/state.json}")/operation.lock"
  SENTINEL="$CONFIG_DIR/deploy-failstop-requested"; FAILSTOP_LOCK=/var/lock/krabs-deploy-failstop.lock
}

publish_image() {
  local full="$1" digest revision id
  run docker build --platform linux/amd64 --build-arg "GIT_SHA=$full" -t "$IMAGE:$full" .
  digest="$(run docker push "$IMAGE:$full" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -1)"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'immutable registry digest is absent'
  id="$(run docker image inspect --format '{{.Id}}' "$IMAGE:$full")"
  revision="$(run docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:$full")"
  [[ -n "$id" && "$revision" == "$full" ]] || die 'local full-SHA image does not prove its revision'
  printf '%s\n' "$digest"
}

stage_remote_controller() {
  local mode="$1" key="$2" full="$3" digest="$4" env_hash="$5" root stage guard order_gate compose env runtime_env ssh_cmd order_gate_hash
  root="$(remote_root)"; ssh_cmd="${KRABS_DEPLOY_SSH:-ssh}"; stage="${root}/config/deploy-controller-${full}.sh"
  guard="${root}/config/krabs-rollback-guard-${full}.sh"
  order_gate="${root}/config/krabs-order-status-migration-gate-${full}.sh"; order_gate_hash="$(sha256sum scripts/krabs-order-status-migration-gate.sh | awk '{print $1}')"
  compose="${root}/docker-compose-deploy-${full}.yml"; env="${root}/config/deploy-env-${full}"; runtime_env="${root}/config/deploy-runtime-env-${full}-${env_hash}"
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "test -f '${runtime_env}' && test \"\$(stat -c '%U %G %a' '${runtime_env}')\" = 'root root 600' && test \"\$(sha256sum '${runtime_env}' | awk '{print \$1}')\" = '${env_hash}'"
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "install -d -m 711 '${root}/config' && cat > '${stage}.tmp' && chmod 700 '${stage}.tmp' && mv -f '${stage}.tmp' '${stage}'" < "$0"
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "cat > '${guard}.tmp' && chmod 700 '${guard}.tmp' && mv -f '${guard}.tmp' '${guard}'" < scripts/krabs-rollback-guard.sh
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "cat > '${order_gate}.tmp' && chmod 700 '${order_gate}.tmp' && mv -f '${order_gate}.tmp' '${order_gate}' && test \"\$(sha256sum '${order_gate}' | awk '{print \$1}')\" = '${order_gate_hash}'" < scripts/krabs-order-status-migration-gate.sh
  sed -e "s|image: ${IMAGE}:latest|image: \${KRABS_IMAGE:?}|g" -e "s|env_file: .env.production|env_file: ${runtime_env}|g" docker-compose.yml | "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "cat > '${compose}.tmp' && chmod 600 '${compose}.tmp' && mv -f '${compose}.tmp' '${compose}'"
  printf 'KRABS_IMAGE=%s:krabs-%s\n' "$IMAGE" "$full" | "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "cat > '${env}.tmp' && chmod 600 '${env}.tmp' && mv -f '${env}.tmp' '${env}'"
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "cd '${root}' && grep -Fc 'env_file: ${runtime_env}' '${compose}' | grep -qx 3 && exec /usr/bin/timeout --signal=TERM --kill-after=60s ${REMOTE_SECONDS}s env KRABS_REMOTE_CONTROLLER=1 KRABS_REMOTE_SHA='${full}' KRABS_REMOTE_DIGEST='${digest}' KRABS_REMOTE_GUARD='${guard}' KRABS_ORDER_STATUS_GATE='${order_gate}' KRABS_ORDER_STATUS_GATE_SHA256='${order_gate_hash}' KRABS_REMOTE_COMPOSE='${compose}' KRABS_REMOTE_ENV='${env}' KRABS_RUNTIME_ENV_PATH='${runtime_env}' KRABS_RUNTIME_ENV_SHA256='${env_hash}' '${stage}' --internal '${mode}' '${key}'"
}

preflight_recovery_env() {
  local full="$1" hash="$2" root ssh_cmd recorded path recorded_hash
  root="$(remote_root)"; ssh_cmd="${KRABS_DEPLOY_SSH:-ssh}"
  recorded="$("$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" "python3 - '${root}/config/deploy-recovery.json' '${full}' '${root}' <<'PY'
import json,os,re,sys
p,sha,root=sys.argv[1:]
if not os.path.exists(p): raise SystemExit(0)
d=json.load(open(p)); path=d['runtimeEnvPath']; digest=d['runtimeEnvSha256']
prefix=f'{root}/config/deploy-runtime-env-{sha}-'
assert d['targetSha']==sha and isinstance(digest,str) and re.fullmatch(r'[0-9a-f]{64}',digest)
assert path==prefix+digest
print(path,digest)
PY
")" || die 'existing recovery environment is corrupt'
  [[ -z "$recorded" ]] && return 0
  read -r path recorded_hash <<<"$recorded"
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" \
    "test -f '${path}' && test \"\$(stat -c '%u %g %a' '${path}')\" = '0 0 600' && test \"\$(sha256sum '${path}' | awk '{print \$1}')\" = '${recorded_hash}'" || die 'existing recovery environment is corrupt'
  [[ "$recorded_hash" == "$hash" ]] || die 'local runtime environment differs from same-SHA recovery'
}

stage_runtime_env() {
  local full="$1" env_hash="$2" source="$3" root runtime_env recovery ssh_cmd
  root="$(remote_root)"; ssh_cmd="${KRABS_DEPLOY_SSH:-ssh}"; runtime_env="${root}/config/deploy-runtime-env-${full}-${env_hash}"
  recovery="${root}/config/deploy-recovery.json"
  "$ssh_cmd" -o BatchMode=yes -o ConnectTimeout=30 "${SERVER_USER}@${SERVER_HOST}" "set -eu; install -d -m 711 '${root}/config'; final='${runtime_env}'; temp='${runtime_env}.tmp'; recovery='${recovery}'; trap 'rm -f -- \"\$temp\"' EXIT; valid() { test -f \"\$final\" && test \"\$(stat -c '%U %G %a' \"\$final\")\" = 'root root 600' && test \"\$(sha256sum \"\$final\" | awk '{print \$1}')\" = '${env_hash}'; }; if valid; then exit 0; fi; if test -e \"\$final\"; then test ! -e \"\$recovery\" || exit 1; rm -f -- \"\$final\"; fi; cat > \"\$temp\"; chown root:root \"\$temp\"; chmod 600 \"\$temp\"; test \"\$(sha256sum \"\$temp\" | awk '{print \$1}')\" = '${env_hash}'; mv -n \"\$temp\" \"\$final\"; valid" < "$source"
}

stage_and_publish() { stage_runtime_env "$1" "$2" "$3"; publish_image "$1"; }

recovery() { atomic "$RECOVERY" "$1"; }
migration_gate() {
  local mode="$1" full="$2" proof
  [[ "$(sha256sum "$ORDER_STATUS_GATE" | awk '{print $1}')" == "$ORDER_STATUS_GATE_SHA256" ]] || die 'staged order-status migration gate hash is invalid'
  proof="$("$ORDER_STATUS_GATE" "$mode" "$full" "$ORDER_STATUS_SNAPSHOT")" || die "order-status migration gate ${mode} failed"
  recovery "$(python3 - "$RECOVERY" "$mode" "$ORDER_STATUS_SNAPSHOT" "$proof" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); proof=json.loads(sys.argv[4]); d['migrationGate']={'mode':sys.argv[2],'snapshotPath':sys.argv[3],**proof}; print(json.dumps(d,separators=(',',':')))
PY
)"
}
migration_receipt() { python3 - "$RECOVERY" "$ORDER_STATUS_SNAPSHOT" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); mode=d['deliveryMode']; gate=d.get('migrationGate')
if mode == 'rollback':
    assert gate is None or isinstance(gate,dict)
    print(json.dumps(gate or {},separators=(',',':')))
else:
    assert mode == 'release' and isinstance(gate,dict)
    assert gate.get('mode') == 'post' and gate.get('snapshotPath') == sys.argv[2]
    assert isinstance(gate.get('candidateCount'),int) and gate['candidateCount'] >= 0
    assert all(isinstance(gate.get(k),str) and len(gate[k]) == 64 for k in ('candidateHash','rowsHash'))
    assert isinstance(gate.get('markerWasPresent'),bool)
    print(json.dumps(gate,separators=(',',':')))
PY
}
advance_recovery() { recovery "$(python3 - "$RECOVERY" "$1" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['phase']=sys.argv[2]; print(json.dumps(d,separators=(',',':')))
PY
)"; }
recovery_field() { python3 - "$RECOVERY" "$1" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))[sys.argv[2]]
print(str(v).lower() if isinstance(v,bool) else v)
PY
}
meta_version() { [[ -e "$META" ]] || { printf '0\n'; return 0; }; python3 - "$META" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); v=d['deployVersion']; assert isinstance(v,int) and v>=0; print(v)
PY
}
candidate_hash() { sha256sum "$1" | awk '{print $1}'; }
owner_ticks() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
owner_alive() { [[ -n "${1:-}" && "$(owner_ticks "$1")" == "$2" ]]; }
worker_pgid() { ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || printf '%s' "$$"; }
write_marker() { atomic "$MARKER" "$(python3 - "$1" <<'PY'
import json,sys,datetime
print(json.dumps({'schemaVersion':1,'deploymentId':sys.argv[1],'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')},separators=(',',':')))
PY
)"; chmod 644 "$MARKER"; }
take() { local p="$1" fd; exec {fd}>"$p"; "$FLOCK" --exclusive --nonblock "$fd"; }

immutable_image() {
  local full="$1" digest id revision
  digest="${KRABS_REMOTE_DIGEST:-}"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'controller lacks locally validated immutable digest'
  run "$DOCKER" pull "$IMAGE@$digest" >&2
  id="$(run "$DOCKER" image inspect --format '{{.Id}}' "$IMAGE@$digest")"
  revision="$(run "$DOCKER" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE@$digest")"
  [[ -n "$id" && "$revision" == "$full" ]] || die 'pulled image does not prove full SHA'
  run "$DOCKER" tag "$IMAGE@$digest" "$IMAGE:krabs-$full"
  [[ "$(run "$DOCKER" image inspect --format '{{.Id}}' "$IMAGE:krabs-$full")" == "$id" ]] || die 'immutable alias is not the pulled image'
  printf '%s %s\n' "$digest" "$id"
}

compose() {
  if test_mode; then run "$DOCKER" compose --env-file "${KRABS_REMOTE_ENV:?}" -f "${KRABS_REMOTE_COMPOSE:?}" "$@"; else run "$DOCKER" compose --project-directory "$SERVER_PATH" -p krabs --env-file "${KRABS_REMOTE_ENV:?}" -f "${KRABS_REMOTE_COMPOSE:?}" "$@"; fi
}
service_ids() { compose ps --all -q "$1" | sed '/^$/d'; }
set_trading_restart() {
  local policy="$1" runtime="${2:-}" manager="${3:-}"
  [[ -n "$runtime" ]] || runtime="$(service_ids krabs-runtime)"; [[ -n "$manager" ]] || manager="$(service_ids krabs-runtime-manager)"
  [[ -n "$runtime" && -n "$manager" ]] || die 'trading container ids are unavailable'
  run "$DOCKER" update "--restart=$policy" "$runtime" "$manager"
}
ordinary_preflight() {
  [[ -f .env.production ]] || die '.env.production is absent'; node -e 'process.exit(+process.versions.node.split(".")[0]>=24?0:1)' || die 'Node >=24 is required'
  pnpm --version >/dev/null; run docker info >/dev/null
  node -e 'const f=require("fs"),o=require("os"),p=require("path");const r=process.env.DOCKER_CONFIG||p.join(o.homedir(),".docker"),d=JSON.parse(f.readFileSync(p.join(r,"config.json")));process.exit(d.auths?.["ghcr.io"]||d.credHelpers?.["ghcr.io"]?0:1)' || die 'GHCR Docker login is required'
}
rollback_preflight() { [[ -z "$(git status --porcelain)" && "$(git branch --show-current)" == master && "$(git rev-parse HEAD)" == "$(git rev-parse origin/master)" ]] || die 'rollback requires tracked, indexed, and untracked clean master at origin'; ordinary_preflight; pnpm run typecheck; pnpm run test; pnpm run lint; }
api_healthy() {
  local api running revision
  api="$(service_ids krabs-api)"; [[ -n "$api" && "$api" != *$'\n'* ]] || return 1
  read -r running revision < <(run "$DOCKER" inspect --format '{{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$api") || return 1
  [[ "$running" == true && "$revision" == "${KRABS_REMOTE_SHA:?}" ]] || return 1
  if test_mode; then run "$DOCKER" health "${KRABS_REMOTE_SHA:?}"; else [[ "$(run "$DOCKER" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api")" == healthy ]]; fi
}
start_and_prove_target_api() {
  local deadline interval
  compose up -d --no-deps --pull never krabs-api
  deadline=$((SECONDS + ${KRABS_DEPLOY_HEALTH_SECONDS:-90})); interval="${KRABS_DEPLOY_HEALTH_INTERVAL_SECONDS:-5}"
  while (( SECONDS <= deadline )); do api_healthy && return 0; sleep "$interval"; done
  return 1
}

fence_runtime_network() {
  local runtime="$1" network="$2" census
  census="$(run "$DOCKER" inspect --format '{{json .NetworkSettings.Networks}}' "$runtime")" || die 'old runtime network census failed'
  if printf '%s' "$census" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert list(d)==[sys.argv[1]]' "$network"; then run "$DOCKER" network disconnect -f "$network" "$runtime" || die 'old runtime network disconnect failed'; fi
  census="$(run "$DOCKER" inspect --format '{{json .NetworkSettings.Networks}}' "$runtime")" || die 'old runtime network post-census failed'
  [[ "$census" == '{}' ]] || die 'old runtime remains network connected'
}

bound_runtime_env() {
  local path hash actual
  path="${KRABS_RUNTIME_ENV_PATH:-}"; hash="${KRABS_RUNTIME_ENV_SHA256:-}"
  [[ "$hash" =~ ^[0-9a-f]{64}$ && -f "$path" ]] || return 1
  test_mode || [[ "$path" == "$CONFIG_DIR"/deploy-runtime-env-* ]] || return 1
  test_mode || [[ "$(stat -c '%U %G %a' "$path")" == 'root root 600' ]] || return 1
  actual="$(sha256sum "$path" | awk '{print $1}')"
  [[ "$actual" == "$hash" ]]
}

json_field() { python3 -c 'import json,sys; v=json.load(sys.stdin)[sys.argv[1]]; print(str(v).lower() if isinstance(v,bool) else v)' "$1"; }
barrier() { [[ -n "${KRABS_DEPLOY_TEST_BARRIER_DIR:-}" && "${KRABS_DEPLOY_TEST_HARD_DEATH:-}" == "$1" ]] || return 0; : >"$KRABS_DEPLOY_TEST_BARRIER_DIR/$1.ready"; kill -KILL "$BASHPID"; }

classify_recovery() {
  [[ -e "$RECOVERY" ]] || return 1
  local verdict
  verdict="$(python3 - "$RECOVERY" "$META" "$1" <<'PY'
import json,os,sys
d=json.load(open(sys.argv[1])); target=sys.argv[3]
required={'schemaVersion','recoveryStateId','phase','deliveryMode','targetSha','digest','imageId','prePaused','previousVersion','baselineCommandHighWater','finalCommandHighWater','targetRuntimeId','targetManagerId','targetNetworkIds','candidateHash','receipt','runtimeEnvPath','runtimeEnvSha256'}
assert required <= set(d) and d.get('schemaVersion')==1 and d.get('targetSha')==target
assert d['deliveryMode'] in ('release','rollback')
if d['deliveryMode']=='release': assert isinstance(d.get('migrationGate'),dict)
elif 'migrationGate' in d: assert isinstance(d['migrationGate'],dict)
assert isinstance(d['previousVersion'],int) and d['previousVersion'] >= 0
assert isinstance(d['targetNetworkIds'],list) and len(d['targetNetworkIds']) <= 1
phase=d['phase']; meta=None
try: meta=json.load(open(sys.argv[2]))
except FileNotFoundError: pass
if meta and phase in ('commit_ready','committed_unacknowledged'):
 assert meta.get('sha')==target and meta.get('recoveryStateId')==d['recoveryStateId']
 assert meta.get('deployVersion')==d['previousVersion']+1
 assert meta.get('digest')==d['digest'] and isinstance(d['receipt'],str) and d['receipt']
 assert meta.get('runtimeEnvSha256')==d['runtimeEnvSha256']
 assert meta.get('receipt')==json.loads(d['receipt']) and meta['receipt'].get('recoveryStateId')==d['recoveryStateId']
 print('advanced')
elif phase == 'commit_ready':
 assert meta is None or meta.get('deployVersion')==d['previousVersion']
 assert d['targetRuntimeId'] and d['targetManagerId'] and len(d['targetNetworkIds']) == 1
 print('commit_ready')
elif phase == 'target_stopped_rearbitrate':
 assert meta is None or meta.get('deployVersion')==d['previousVersion']
 assert d['targetRuntimeId'] and d['targetManagerId'] and len(d['targetNetworkIds']) == 1
 print('target_stopped_rearbitrate')
elif phase == 'arbitration_boundary':
 assert not d['receipt'] and (meta is None or meta.get('deployVersion')==d['previousVersion'])
 print('arbitration_boundary')
elif phase in ('baseline_captured','fenced','cutover_paused','migration_gate_pre'): print('early_recovery')
elif phase in ('rollback_bound','rollback_bound_owner_dead','prepared','target_started'): print(phase)
else: raise SystemExit(2)
PY
)" || die 'recovery classifier rejected malformed or foreign state'
  RECOVERY_DISPOSITION="$verdict"
  if [[ "$verdict" == advanced ]]; then
    local receipt; receipt="$(recovery_field receipt)"
    set_trading_restart unless-stopped
    rm -f "$RECOVERY" "$MARKER" "$SENTINEL"
    printf 'DEPLOY_RECEIPT %s\n' "$receipt"
    return 0
  fi
  return 1
}

reenter_stopped_target() {
  local state_id="$1" full="$2" pre="$3" baseline="$4" network runtime manager arbitration effective running revision
  state_id="$(recovery_field recoveryStateId)"
  runtime="$(recovery_field targetRuntimeId)"; manager="$(recovery_field targetManagerId)"
  network="$(python3 - "$RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(d['targetNetworkIds'][0])
PY
)"
  read -r running revision < <(run "$DOCKER" inspect --format '{{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$runtime")
  [[ "$running" == false && "$revision" == "$full" ]] || die 're-entry runtime is not the stopped target'
  read -r running revision < <(run "$DOCKER" inspect --format '{{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$manager")
  [[ "$running" == false && "$revision" == "$full" ]] || die 're-entry manager is not the stopped target'
  local census; census="$(run "$DOCKER" inspect --format '{{json .NetworkSettings.Networks}}' "$runtime")" || die 're-entry network census failed'
  if [[ "$census" == '{}' ]]; then
    run "$DOCKER" network connect "$network" "$runtime" || die 're-entry network connect failed'
    census="$(run "$DOCKER" inspect --format '{{json .NetworkSettings.Networks}}' "$runtime")"
  fi
  printf '%s' "$census" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d,dict) and list(d)==[sys.argv[1]]' "$network" || die 're-entry runtime network is not the saved default'
  start_and_prove_target_api || die 're-entry target API health was not proven; deploy remains fail-stopped'
  KRABS_RUNTIME_ENV_PATH="$(recovery_field runtimeEnvPath)" KRABS_RUNTIME_ENV_SHA256="$(recovery_field runtimeEnvSha256)" "$GUARD" deploy-cutoff-probe "$state_id" || die 're-entry bound runtime environment is invalid'
  [[ "$(recovery_field deliveryMode)" != release ]] || migration_gate post "$full"
  run "$DOCKER" start "$runtime"; run "$DOCKER" start "$manager"
  arbitration="$("$GUARD" deploy-arbitrate "$state_id" "$pre" "$baseline")" || die 're-entry final command arbitration was not proven'
  effective="$(printf '%s' "$arbitration" | json_field effectivePaused)" || die 're-entry command receipt is malformed'
  recovery "$(python3 - "$RECOVERY" "$arbitration" "$(migration_receipt)" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=json.loads(sys.argv[2]); r={'baselineCapturedUnderLock':d['baselineCapturedUnderLock'],'prePaused':d['prePaused'],'preRunId':d['preRunId'],'preInstanceId':d['preInstanceId'],'previousVersion':d['previousVersion'],'deployVersion':d['previousVersion']+1,'sha':d['targetSha'],'digest':d['digest'],'recoveryStateId':d['recoveryStateId'],'migration101':json.loads(sys.argv[3]),**a}; d.update(phase='commit_ready',finalCommandHighWater=a['finalOperatorCommandHighWater'],receipt=json.dumps(r,separators=(',',':'))); print(json.dumps(d,separators=(',',':')))
PY
 )"
  printf '%s\n' "$effective"
}

reset_early_recovery() {
  local phase runtime network census
  phase="$(recovery_field phase)"; runtime="$(recovery_field preRuntimeId)"
  if [[ "$phase" == fenced || "$phase" == cutover_paused ]]; then
    network="$(python3 - "$RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(d['targetNetworkIds'][0])
PY
)"; census="$(run "$DOCKER" inspect --format '{{json .NetworkSettings.Networks}}' "$runtime")"
    [[ "$census" == '{}' ]] && run "$DOCKER" network connect "$network" "$runtime"
  fi
  rm -f "$RECOVERY" "$MARKER" "$SENTINEL"
}

commit_metadata() {
  local full="$1" digest="$2" state_id="$3" effective="$4" candidate version api high receipt env_hash
  version="$(recovery_field previousVersion)"; candidate="${META}.candidate.${state_id}"
  api="$(service_ids krabs-api)"; high="$(recovery_field finalCommandHighWater)"; receipt="$(recovery_field receipt)"
  [[ -n "$api" && "$high" =~ ^[0-9]+$ && -n "$receipt" ]] || die 'metadata receipt or command high-water is unavailable'
  env_hash="$(recovery_field runtimeEnvSha256)"; atomic "$candidate" "$(python3 - "$full" "$digest" "$state_id" "$version" "$api" "$high" "$receipt" "$(recovery_field prePaused)" "$env_hash" <<'PY'
import json,sys,datetime
r=json.loads(sys.argv[7]); r.update(sha=sys.argv[1],digest=sys.argv[2],recoveryStateId=sys.argv[3],prePaused=sys.argv[8]=='true',previousVersion=int(sys.argv[4]),deployVersion=int(sys.argv[4])+1)
print(json.dumps({'deployVersion':int(sys.argv[4])+1,'sha':sys.argv[1],'digest':sys.argv[2],'recoveryStateId':sys.argv[3],'apiId':sys.argv[5],'finalOperatorCommandHighWater':int(sys.argv[6]),'runtimeEnvSha256':sys.argv[9],'resumeCutoffAware':True,'receipt':r,'deployedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')},separators=(',',':')))
PY
)"
  chmod 644 "$candidate"
  recovery "$(python3 - "$RECOVERY" "$(candidate_hash "$candidate")" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['candidateHash']=sys.argv[2]; print(json.dumps(d,separators=(',',':')))
PY
)"
  owner_alive "$$" "$(owner_ticks $$)" || die 'controller owner changed before metadata commit'; barrier after-final-check-before-metadata-rename
  python3 - "$candidate" "$META" "$full" "$state_id" <<'PY'
import json,os,sys
d=json.load(open(sys.argv[1])); assert d['sha']==sys.argv[3] and d['recoveryStateId']==sys.argv[4]
os.replace(sys.argv[1],sys.argv[2])
PY
  set_trading_restart unless-stopped
  recovery "$(python3 - "$RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['phase']='committed_unacknowledged'; print(json.dumps(d,separators=(',',':')))
PY
)"
  receipt="$(recovery_field receipt)"; rm -f "$MARKER" "$RECOVERY" "$SENTINEL"
  printf 'DEPLOY_RECEIPT %s\n' "$receipt"
}

controller() {
  local mode="$1" key="$2" full digest image_id state_id phase pre version candidate baseline runtime network cutover arbitration effective marker_aware
  deploy_paths; full="${KRABS_REMOTE_SHA:-$(git rev-parse HEAD)}"; sha "$full" || die 'HEAD must be a full SHA'
  mkdir -p "$CONFIG_DIR" "$(dirname "$ROLLBACK_OPERATION_LOCK")"; chmod 700 "$(dirname "$ROLLBACK_OPERATION_LOCK")"; take "$LOCK" || die 'deploy operation in progress'; take "$ROLLBACK_OPERATION_LOCK" || die 'rollback operation is in progress'; export KRABS_DEPLOY_OPERATION_OWNER=1
  RECOVERY_DISPOSITION=normal
  if [[ -e "$RECOVERY" ]]; then
    [[ "$(recovery_field runtimeEnvSha256)" == "${KRABS_RUNTIME_ENV_SHA256:-}" ]] || die 'same-SHA retry runtime environment differs from recovery'
    KRABS_RUNTIME_ENV_PATH="$(recovery_field runtimeEnvPath)"; KRABS_RUNTIME_ENV_SHA256="$(recovery_field runtimeEnvSha256)"
    recovery "$(python3 - "$RECOVERY" "$$" "$(owner_ticks $$)" "$(worker_pgid)" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d.update(controllerPid=int(sys.argv[2]),controllerStartTicks=sys.argv[3],workerPgid=int(sys.argv[4])); print(json.dumps(d,separators=(',',':')))
PY
)"
  fi
  bound_runtime_env || die 'bound runtime environment is missing or corrupt'
  classify_recovery "$full" && return 0
  if [[ "$RECOVERY_DISPOSITION" == arbitration_boundary ]]; then
    "$GUARD" deploy-watch || die 'arbitration-boundary fail-stop was not proven'
  fi
  if [[ "$RECOVERY_DISPOSITION" == early_recovery ]]; then phase="$(recovery_field phase)"; state_id="$(recovery_field recoveryStateId)"; pre="$(recovery_field prePaused)"; runtime="$(recovery_field preRuntimeId)"; digest="$(recovery_field digest)"; version="$(recovery_field previousVersion)"; image_id="$(recovery_field imageId)"; baseline="$(python3 - "$RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ('prePaused','preRunId','preInstanceId','preRuntimeId','preApiId','preManagerId','baselineCommandHighWater')},separators=(',',':')))
PY
)"; RECOVERY_DISPOSITION=normal; else phase=normal; fi
  if [[ "$RECOVERY_DISPOSITION" == target_stopped_rearbitrate || "$RECOVERY_DISPOSITION" == commit_ready || "$RECOVERY_DISPOSITION" == arbitration_boundary ]]; then
    pre="$(recovery_field prePaused)"; baseline="$(recovery_field baselineCommandHighWater)"
    effective="$(reenter_stopped_target '' "$full" "$pre" "$baseline")"
    commit_metadata "$full" "$(recovery_field digest)" "$(recovery_field recoveryStateId)" "$effective"
    return 0
  fi
  [[ "$RECOVERY_DISPOSITION" == normal ]] || die "recovery classifier requires deploy-watch: $RECOVERY_DISPOSITION"
  if [[ "$phase" == normal && "$mode" == release ]]; then
    [[ ! -e "$KRABS_ROLLBACK_STATE" && ! -e "${KRABS_ROLLBACK_MARKER_PATH:-/opt/krabs/config/rollback-in-progress.json}" ]] || die 'rollback ownership is active'
  fi
  if [[ "$phase" == normal && "$mode" == rollback ]]; then
    [[ -f "$KRABS_ROLLBACK_STATE" ]] || die 'rollback state is absent'
    state_id="$(python3 - "$KRABS_ROLLBACK_STATE" "$key" "$full" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); assert d['rollbackStateId']==sys.argv[2] and d['phase']=='prepared' and d['targetSha']==sys.argv[3]
print(d['rollbackStateId'])
PY
)" || die 'rollback binding is invalid'
    pre=true
  elif [[ "$phase" == normal ]]; then
    state_id="$(python3 -c 'import uuid;print(uuid.uuid4())')"; pre=false
  fi
  if [[ "$phase" == normal ]]; then
    baseline="$($GUARD deploy-baseline)" || die 'authoritative pre-cutoff baseline is unavailable'; pre="$(printf '%s' "$baseline" | json_field prePaused)" || die 'baseline is malformed'; runtime="$(printf '%s' "$baseline" | json_field preRuntimeId)" || die 'baseline is malformed'; version="$(meta_version)" || die 'deployment metadata is corrupt'; marker_aware="$(python3 - "$META" "$(printf '%s' "$baseline" | json_field preApiId)" <<'PY'
import json,os,sys
if not os.path.exists(sys.argv[1]): print('false')
else:
 d=json.load(open(sys.argv[1])); print(str(d.get('resumeCutoffAware') is True and d.get('apiId') == sys.argv[2]).lower())
PY
)" || die 'deployment metadata is corrupt'; [[ "$marker_aware" == true || "$pre" != true ]] || die 'paused marker-unaware baseline requires a marker-aware upgrade'; digest=''; image_id=''; read -r digest image_id < <(immutable_image "$full"); [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'immutable image result is malformed'
    recovery "$(python3 - "$state_id" "$mode" "$full" "$digest" "$image_id" "$pre" "$version" "$$" "$(owner_ticks $$)" "$(worker_pgid)" "$baseline" "$KRABS_RUNTIME_ENV_PATH" "$KRABS_RUNTIME_ENV_SHA256" <<'PY'
import json,sys
baseline=json.loads(sys.argv[11])
print(json.dumps({'schemaVersion':1,'recoveryStateId':sys.argv[1],'deliveryMode':sys.argv[2],'phase':'rollback_bound' if sys.argv[2]=='rollback' else 'baseline_captured','targetSha':sys.argv[3],'digest':sys.argv[4],'imageId':sys.argv[5],'prePaused':sys.argv[6]=='true','previousVersion':int(sys.argv[7]),'baselineCapturedUnderLock':True,'baselineCommandHighWater':baseline['baselineCommandHighWater'],'finalCommandHighWater':0,'preRunId':baseline['preRunId'],'preInstanceId':baseline['preInstanceId'],'preRuntimeId':baseline['preRuntimeId'],'preApiId':baseline['preApiId'],'preManagerId':baseline['preManagerId'],'controllerPid':int(sys.argv[8]),'controllerStartTicks':sys.argv[9],'workerPgid':int(sys.argv[10]),'tradingCutoverInvoked':False,'targetRuntimeId':'','targetManagerId':'','targetNetworkIds':[],'restartPolicies':{'runtime':'unless-stopped','manager':'unless-stopped'},'candidateHash':'','receipt':'','migrationGate':{},'runtimeEnvPath':sys.argv[12],'runtimeEnvSha256':sys.argv[13]},separators=(',',':')))
PY
)"
    barrier baseline-pre-boundary
  fi
  "$GUARD" install-service
  marker_aware="${marker_aware:-false}"
  if [[ "$(recovery_field phase)" == rollback_bound ]]; then advance_recovery baseline_captured; phase=baseline_captured; fi
  if [[ "$phase" == normal ]] || { [[ "$phase" == baseline_captured && "$(recovery_field targetNetworkIds)" == '[]' ]]; }; then
    if [[ "$marker_aware" == true ]]; then write_marker "$state_id"; fi
    network="$(run "$DOCKER" inspect --format '{{json .NetworkSettings.Networks}}' "$runtime" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d,dict) and len(d)==1; print(next(iter(d)))')" || die 'old runtime network census is not exactly one network'
    recovery "$(python3 - "$RECOVERY" "$network" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['targetNetworkIds']=[sys.argv[2]]; print(json.dumps(d,separators=(',',':')))
PY
)"
    barrier after-network-save-before-disconnect
    fence_runtime_network "$runtime" "$network"; barrier after-disconnect-before-fenced-phase; advance_recovery fenced; phase=fenced
  else network="$(python3 - "$RECOVERY" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['targetNetworkIds'][0])
PY
)"; fi
  [[ "$phase" != baseline_captured ]] || { network="$(python3 - "$RECOVERY" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['targetNetworkIds'][0])
PY
)"; fence_runtime_network "$runtime" "$network"; barrier after-disconnect-before-fenced-phase; advance_recovery fenced; phase=fenced; }
  if [[ "$phase" != cutover_paused ]]; then compose stop krabs-api krabs-runtime-manager krabs-runtime; cutover="$($GUARD deploy-cutover "$state_id")" || die 'quiesce pause was not applied'; recovery "$(python3 - "$RECOVERY" "$cutover" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); c=json.loads(sys.argv[2]); d.update(phase='cutover_paused',baselineCommandHighWater=c['cutoverCommandHighWater'],tradingCutoverInvoked=True); print(json.dumps(d,separators=(',',':')))
PY
)"; fi
  if [[ "$mode" == release ]]; then
    migration_gate pre "$full"
    advance_recovery migration_gate_pre
    phase=migration_gate_pre
    barrier migration_gate_pre
  fi
  [[ "$marker_aware" == true ]] || write_marker "$state_id"
  compose create --pull never krabs-runtime krabs-runtime-manager
  runtime="$(service_ids krabs-runtime)"; manager="$(service_ids krabs-runtime-manager)"
  [[ -n "$runtime" && -n "$manager" ]] || die 'target containers were not created'
  set_trading_restart no "$runtime" "$manager"
  recovery "$(python3 - "$RECOVERY" "$runtime" "$manager" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d.update(phase='target_started',targetRuntimeId=sys.argv[2],targetManagerId=sys.argv[3]); print(json.dumps(d,separators=(',',':')))
PY
)"
  barrier after-target-started-before-api
  if ! start_and_prove_target_api; then
    set_trading_restart no || true
    runtime="$(service_ids krabs-runtime || true)"; manager="$(service_ids krabs-runtime-manager || true)"
    [[ -z "$manager" ]] || run "$DOCKER" stop "$manager" || true; [[ -z "$runtime" ]] || run "$DOCKER" stop "$runtime" || true
    die 'target health was not proven; deploy remains fail-stopped'
  fi
  KRABS_RUNTIME_ENV_PATH="$(recovery_field runtimeEnvPath)" KRABS_RUNTIME_ENV_SHA256="$(recovery_field runtimeEnvSha256)" "$GUARD" deploy-cutoff-probe "$state_id" || die 'marker-aware Resume cutoff was not proven'
  [[ "$mode" != release ]] || migration_gate post "$full"
  run "$DOCKER" start "$runtime"; run "$DOCKER" start "$manager"
  advance_recovery arbitration_boundary
  barrier arbitration_boundary
  arbitration="$($GUARD deploy-arbitrate "$state_id" "$pre" "$(recovery_field baselineCommandHighWater)")" || die 'final command arbitration was not proven'
  effective="$(printf '%s' "$arbitration" | json_field effectivePaused)" || die 'final command receipt is malformed'
  recovery "$(python3 - "$RECOVERY" "$arbitration" "$(migration_receipt)" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=json.loads(sys.argv[2]); r={'baselineCapturedUnderLock':d['baselineCapturedUnderLock'],'prePaused':d['prePaused'],'preRunId':d['preRunId'],'preInstanceId':d['preInstanceId'],'previousVersion':d['previousVersion'],'deployVersion':d['previousVersion']+1,'sha':d['targetSha'],'digest':d['digest'],'recoveryStateId':d['recoveryStateId'],'migration101':json.loads(sys.argv[3]),**a}; d.update(phase='commit_ready',finalCommandHighWater=a['finalOperatorCommandHighWater'],receipt=json.dumps(r,separators=(',',':')));print(json.dumps(d,separators=(',',':')))
PY
 )"
  barrier commit_ready
  commit_metadata "$full" "$digest" "$state_id" "$effective"
}

real_deploy() { controller "$@"; }
main() {
  TIMEOUT="${KRABS_DEPLOY_TIMEOUT:-/usr/bin/timeout}"
  case "${1:-}" in
    --print-gate-input-hash) gate_hash ;;
    --verify-gate-evidence-only) [[ $# == 2 ]] || die 'usage'; verify_gate "$2" ;;
    --verify-rollback-boundary) [[ $# == 3 ]] || die 'usage'; verify_rollback_boundary "$2" "$3" ;;
    --gate-evidence) [[ $# == 2 ]] || die 'release requires exactly --gate-evidence'; exec "$TIMEOUT" --signal=TERM --kill-after=60s "${DEPLOY_SECONDS}s" "$0" --deadline release "$2" ;;
    --rollback-state-id) [[ $# == 2 ]] || die 'rollback requires exactly --rollback-state-id'; exec "$TIMEOUT" --signal=TERM --kill-after=60s "${DEPLOY_SECONDS}s" "$0" --deadline rollback "$2" ;;
    --deadline) [[ $# == 3 ]] || die 'deadline invocation'; if [[ "$2" == release ]]; then verify_gate "$3"; test_mode || ordinary_preflight; else test_mode || rollback_preflight; fi; full="$(git rev-parse HEAD)"; sha "$full" || die 'HEAD must be a full SHA'; source="${KRABS_DEPLOY_LOCAL_ENV_PATH:-.env.production}"; test_mode || [[ "$source" == .env.production ]] || die 'production runtime environment path is invalid'; env_hash="$(sha256sum "$source" | awk '{print $1}')"; if test_mode; then KRABS_ROLLBACK_STATE="${KRABS_ROLLBACK_STATE_PATH:-/var/lib/krabs-rollback-guard/state.json}"; KRABS_REMOTE_SHA="$full" KRABS_REMOTE_DIGEST="$(publish_image "$full")" KRABS_REMOTE_COMPOSE="${KRABS_DEPLOY_COMPOSE:-docker-compose.yml}" KRABS_REMOTE_ENV="${KRABS_DEPLOY_ENV:-.env.production}" KRABS_RUNTIME_ENV_PATH="${KRABS_RUNTIME_ENV_PATH:-.env.production}" KRABS_RUNTIME_ENV_SHA256="${KRABS_RUNTIME_ENV_SHA256:-$env_hash}" real_deploy "$2" "$3"; elif [[ "${KRABS_REMOTE_CONTROLLER:-}" == 1 ]]; then KRABS_ROLLBACK_STATE="${KRABS_ROLLBACK_STATE_PATH:-/var/lib/krabs-rollback-guard/state.json}"; real_deploy "$2" "$3"; else preflight_recovery_env "$full" "$env_hash"; digest="$(stage_and_publish "$full" "$env_hash" "$source")"; stage_remote_controller "$2" "$3" "$full" "$digest" "$env_hash"; fi ;;
    --test-local-release) [[ $# == 1 ]] && test_mode || die 'test local release only'; full="$(git rev-parse HEAD)"; source="${KRABS_DEPLOY_LOCAL_ENV_PATH:?}"; env_hash="$(sha256sum "$source" | awk '{print $1}')"; preflight_recovery_env "$full" "$env_hash"; digest="$(stage_and_publish "$full" "$env_hash" "$source")"; stage_remote_controller release test "$full" "$digest" "$env_hash" ;;
    --internal) [[ $# == 3 && "${KRABS_REMOTE_CONTROLLER:-}" == 1 ]] || die 'internal invocation is remote-controller only'; deploy_paths; KRABS_ROLLBACK_STATE="${KRABS_ROLLBACK_STATE_PATH:-/var/lib/krabs-rollback-guard/state.json}"; real_deploy "$2" "$3" ;;
    *) die 'choose exactly one deploy mode: --gate-evidence or --rollback-state-id' ;;
  esac
}
main "$@"
