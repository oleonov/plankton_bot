#!/usr/bin/env bash
set -euo pipefail
readonly PRODUCTION_STATE_DIR=/var/lib/krabs-rollback-guard
readonly PRODUCTION_MARKER=/opt/krabs/config/rollback-in-progress.json
readonly PRODUCTION_CONTROL_DB=/var/lib/docker/volumes/krabs-data/_data/control.db
readonly PRODUCTION_DATA_DIR=/var/lib/docker/volumes/krabs-data/_data
readonly PRODUCTION_DEPLOY_LOCK=/var/lock/krabs-deploy.lock
readonly PRODUCTION_DEPLOY_RECOVERY=/opt/krabs/config/deploy-recovery.json
readonly PRODUCTION_DEPLOY_META=/opt/krabs/config/deploy-meta.json
readonly PRODUCTION_DEPLOY_SENTINEL=/opt/krabs/config/deploy-failstop-requested
readonly PRODUCTION_FAILSTOP_LOCK=/var/lock/krabs-deploy-failstop.lock
die() { printf '%s\n' "$*" >&2; exit 1; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{7,40}$ ]]; }
configure() {
  local test_mode="${KRABS_ROLLBACK_TEST_MODE:-}"
  if [[ -n "$test_mode" && "$test_mode" != 1 ]]; then die "KRABS_ROLLBACK_TEST_MODE must be 1"; fi
  if [[ "$test_mode" == 1 ]]; then
    STATE_DIR="${KRABS_ROLLBACK_STATE_DIR:-$PRODUCTION_STATE_DIR}"
    MARKER_PATH="${KRABS_ROLLBACK_MARKER_PATH:-$PRODUCTION_MARKER}"
    CONTROL_DB="${KRABS_ROLLBACK_CONTROL_DB_PATH:-$PRODUCTION_CONTROL_DB}"
    DATA_DIR="${KRABS_ROLLBACK_DATA_DIR:-$PRODUCTION_DATA_DIR}"
    API_BASE="${KRABS_ROLLBACK_API_BASE:-http://127.0.0.1:3100}"
    DOCKER="${KRABS_ROLLBACK_DOCKER:-/usr/bin/docker}"
    SQLITE="${KRABS_ROLLBACK_SQLITE:-/usr/bin/sqlite3}"
    FLOCK="${KRABS_ROLLBACK_FLOCK:-/usr/bin/flock}"
    SYSTEMCTL="${KRABS_ROLLBACK_SYSTEMCTL:-/usr/bin/systemctl}"
    INSTALL_BIN="${KRABS_ROLLBACK_INSTALL_BIN:-/usr/local/sbin/krabs-rollback-guard}"
    UNIT_DIR="${KRABS_ROLLBACK_UNIT_DIR:-/etc/systemd/system}"
    TIMEOUT_BIN="${KRABS_ROLLBACK_TIMEOUT_BIN:-/usr/bin/timeout}"
    CURL="${KRABS_ROLLBACK_CURL:-curl}"
    DEPLOY_LOCK="${KRABS_DEPLOY_LOCK_PATH:-$PRODUCTION_DEPLOY_LOCK}"
    DEPLOY_RECOVERY="${KRABS_DEPLOY_RECOVERY_PATH:-$PRODUCTION_DEPLOY_RECOVERY}"
    DEPLOY_META="${KRABS_DEPLOY_METADATA_PATH:-$PRODUCTION_DEPLOY_META}"
    DEPLOY_SENTINEL="${KRABS_DEPLOY_FAILSTOP_PATH:-$PRODUCTION_DEPLOY_SENTINEL}"
    FAILSTOP_LOCK="${KRABS_DEPLOY_FAILSTOP_LOCK_PATH:-$PRODUCTION_FAILSTOP_LOCK}"
  else
    STATE_DIR="$PRODUCTION_STATE_DIR"; MARKER_PATH="$PRODUCTION_MARKER"; CONTROL_DB="$PRODUCTION_CONTROL_DB"
    DATA_DIR="$PRODUCTION_DATA_DIR"; API_BASE=http://127.0.0.1:3100; DOCKER=/usr/bin/docker; SQLITE=/usr/bin/sqlite3
    FLOCK=/usr/bin/flock; SYSTEMCTL=/usr/bin/systemctl; INSTALL_BIN=/usr/local/sbin/krabs-rollback-guard
    UNIT_DIR=/etc/systemd/system; TIMEOUT_BIN=/usr/bin/timeout; CURL=curl; DEPLOY_LOCK="$PRODUCTION_DEPLOY_LOCK"
    DEPLOY_RECOVERY="$PRODUCTION_DEPLOY_RECOVERY"; DEPLOY_META="$PRODUCTION_DEPLOY_META"; DEPLOY_SENTINEL="$PRODUCTION_DEPLOY_SENTINEL"; FAILSTOP_LOCK="$PRODUCTION_FAILSTOP_LOCK"
  fi
  POLL_INTERVAL="${KRABS_ROLLBACK_POLL_INTERVAL_SECONDS:-2}"
  POLL_ATTEMPTS="${KRABS_ROLLBACK_POLL_ATTEMPTS:-15}"
  COMMAND_TIMEOUT="${KRABS_ROLLBACK_COMMAND_TIMEOUT_SECONDS:-75}"
  STATE_FILE="$STATE_DIR/state.json"; LOCK_FILE="$STATE_DIR/operation.lock"
}
atomic_write() { local path="$1" value="$2" tmp; tmp="${path}.tmp.$$"; umask 077; printf '%s\n' "$value" > "$tmp"; mv -f "$tmp" "$path"; }
state_json() { cat "$STATE_FILE"; }
state_field() { state_json | python3 -c 'import json,sys; v=json.load(sys.stdin)[sys.argv[1]]; print(str(v).lower() if isinstance(v,bool) else v)' "$1"; }
write_state() { atomic_write "$STATE_FILE" "$1"; chmod 600 "$STATE_FILE"; }
update_phase() { local phase="$1"; write_state "$(state_json | python3 -c 'import json,sys; d=json.load(sys.stdin); d["phase"]=sys.argv[1]; print(json.dumps(d,separators=(",",":")))' "$phase")"; }
read_state_or_die() { [[ -f "$STATE_FILE" ]] || die "rollback state is absent"; python3 - "$STATE_FILE" <<'PY'
import json,re,sys
d=json.load(open(sys.argv[1])); required={"schemaVersion","rollbackStateId","phase","preRollbackPaused","startedAt","originalSha","targetSha","baselineCommandHighWater"}
terminal={"finalOperatorCommandHighWater","effectivePaused"}
if set(d)-required-terminal or not required <= set(d) or d["schemaVersion"] != 1: raise SystemExit(2)
if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", d["rollbackStateId"]): raise SystemExit(3)
if d["phase"] not in {"arming","prepared","deploying","blocked","restored"}: raise SystemExit(4)
if d["preRollbackPaused"] is not None and type(d["preRollbackPaused"]) is not bool: raise SystemExit(5)
if (d["phase"]=="restored") != (terminal <= set(d)) or (terminal <= set(d) and (type(d["effectivePaused"]) is not bool or not isinstance(d["finalOperatorCommandHighWater"],int))): raise SystemExit(7)
if not all(isinstance(d[x],str) and re.fullmatch(r"[0-9a-f]{7,40}",d[x]) for x in ("originalSha","targetSha")): raise SystemExit(6)
PY
}
api_json() {
  local -a auth=()
  if [[ "${KRABS_ROLLBACK_TEST_MODE:-}" != 1 ]]; then
    local key
    [[ "${KRABS_RUNTIME_ENV_PATH:-}" == /opt/krabs/config/deploy-runtime-env-* && -f "$KRABS_RUNTIME_ENV_PATH" ]] || return 1
    key="$(sed -n 's/^KRABS_API_KEY=//p' "$KRABS_RUNTIME_ENV_PATH" | tail -1)"
    [[ -n "$key" ]] || return 1
    auth=(-H "Authorization: Bearer $key")
  fi
  "$CURL" --silent --show-error --fail --connect-timeout 1 --max-time 2 "${auth[@]}" "$API_BASE$1"
}
paused_status() { api_json /api/v1/status | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and isinstance(d.get("data"),dict) and type(d["data"].get("paused")) is bool; print(str(d["data"]["paused"]).lower())'; }
health_sha() { api_json /api/v1/health | python3 -c 'import json,re,sys; d=json.load(sys.stdin); s=d.get("data",{}).get("sha") if d.get("ok") is True and isinstance(d.get("data"),dict) else None; assert isinstance(s,str) and re.fullmatch(r"[0-9a-f]{7,40}",s); print(s)'; }
read_identity() {
  local expected="$1" service id revision running
  for service in krabs-runtime krabs-api krabs-runtime-manager; do
    id="$(compose ps -q "$service")" || return 1
    [[ "$(printf '%s\n' "$id" | sed '/^$/d' | wc -l | tr -d ' ')" == 1 ]] || return 1
    read -r running revision < <("$DOCKER" inspect --format '{{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id") || return 1
    [[ "$running" == true && "$revision" == "$expected" ]] || return 1
  done
  [[ "$(health_sha)" == "$expected" ]]
}
compose() {
  if [[ "${KRABS_ROLLBACK_TEST_MODE:-}" == 1 ]]; then "$DOCKER" compose "$@"; else "$DOCKER" compose --project-directory /opt/krabs -p krabs "$@"; fi
}
marker_json() { local state="$1" phase="$2" original="$3" target="$4"; python3 - "$state" "$phase" "$original" "$target" <<'PY'
import json,sys,datetime
print(json.dumps({"schemaVersion":1,"rollbackStateId":sys.argv[1],"phase":sys.argv[2],"originalSha":sys.argv[3],"targetSha":sys.argv[4],"updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")},separators=(",",":")))
PY
}
write_marker_from_state() { atomic_write "$MARKER_PATH" "$(marker_json "$(state_field rollbackStateId)" "$(state_field phase)" "$(state_field originalSha)" "$(state_field targetSha)")"; chmod 644 "$MARKER_PATH"; }
sql() { "$SQLITE" "$CONTROL_DB" "$1"; }
multirow_count() { sql "SELECT count(*) FROM (SELECT token_id FROM positions WHERE status IN ('open','dust') GROUP BY token_id HAVING count(*) > 1);" | tr -d '[:space:]'; }
baseline_high_water() { sql "SELECT coalesce(max(id),0) FROM operator_commands;" | tr -d '[:space:]'; }
cutoff_high_water() { sql "BEGIN IMMEDIATE; SELECT coalesce(max(id),0) FROM operator_commands; COMMIT;" | tr -d '[:space:]'; }
ensure_command() {
  local action="$1" state_id="$2" expected="$3" created initiator row status paused attempt; initiator="rollback:${state_id}:${action}"
  created="$( [[ "$action" == resume ]] && printf '0001-01-01T00:00:00.000Z' || date -u +%Y-%m-%dT%H:%M:%S.000Z )"
  row="$(sql "BEGIN IMMEDIATE; INSERT INTO operator_commands(action,reason,initiator_type,initiator,status,created_at) SELECT '$action','rollback guard','system','$initiator','pending','$created' WHERE NOT EXISTS (SELECT 1 FROM operator_commands WHERE initiator='$initiator'); SELECT count(*) || '|' || coalesce(min(action),'') || '|' || coalesce(min(initiator_type),'') || '|' || coalesce(min(created_at),'') FROM operator_commands WHERE initiator='$initiator'; COMMIT;" | tail -n 1)"
  [[ "$row" == "1|$action|system|"* && ( "$action" == pause || "$row" == "1|resume|system|$created" ) ]] || return 1
  for ((attempt=0; attempt<POLL_ATTEMPTS; attempt++)); do
    status="$(sql "SELECT status FROM operator_commands WHERE initiator='$initiator';")"; paused="$(paused_status)" || return 1
    [[ "$status" == applied && "$paused" == "$expected" ]] && return 0
    [[ "$status" == rejected ]] && return 1
    sleep "$POLL_INTERVAL"
  done
  return 1
}
arming_without_marker() { local id original commands; id="$(state_field rollbackStateId)"; original="$(state_field originalSha)"; commands="$(sql "SELECT count(*) FROM operator_commands WHERE initiator LIKE 'rollback:$id:%';" | tr -d '[:space:]')"; [[ "$commands" == 0 ]] && read_identity "$original"; }
finish_arming() {
  local high paused id; id="$(state_field rollbackStateId)"
  if [[ "$(state_field preRollbackPaused)" == None ]]; then
    high="$(cutoff_high_water)" || return 1; settle_operator_commands "$high" || return 1; paused="$(paused_status)" || return 1
    write_state "$(state_json | python3 -c 'import json,sys; d=json.load(sys.stdin); d.update(preRollbackPaused=sys.argv[1]=="true",baselineCommandHighWater=int(sys.argv[2])); print(json.dumps(d,separators=(",",":")))' "$paused" "$high")"
  fi; ensure_command pause "$id" true || return 1; update_phase prepared; write_marker_from_state
}
settle_operator_commands() {
  local high="$1" pending attempt; for ((attempt=0; attempt<POLL_ATTEMPTS; attempt++)); do
    pending="$(sql "SELECT count(*) FROM operator_commands WHERE initiator_type='operator' AND id <= $high AND status NOT IN ('applied','rejected');" | tr -d '[:space:]')"; [[ "$pending" == 0 ]] && return 0
    sleep "$POLL_INTERVAL"
  done
  return 1
}
restore_action() {
  local high="$1" pre="$2" rows row action status; rows="$(sql "SELECT action || '|' || status FROM operator_commands WHERE initiator_type='operator' AND id > $high ORDER BY created_at ASC,id ASC;")"
  [[ -n "$rows" ]] || { [[ "$pre" == false ]] && printf 'resume\n' || printf 'pause\n'; return; }
  while IFS='|' read -r action status; do
    [[ "$action" != resume ]] || return 1; [[ "$status" == applied || "$status" == rejected ]] || return 2
  done <<< "$rows"
  printf 'pause\n'
}
settled_restore_action() {
  local high="$1" pre="$2" action attempt; for ((attempt=0; attempt<POLL_ATTEMPTS; attempt++)); do
    action="$(restore_action "$high" "$pre")" && { printf '%s\n' "$action"; return; }; [[ $? == 2 ]] || return 1; sleep "$POLL_INTERVAL"
  done
  return 1
}
deploy_baseline() {
  local paused sha runtime api manager high run instance
  read -r paused run instance < <(sql "SELECT (CASE paused WHEN 1 THEN 'true' WHEN 0 THEN 'false' END) || ' ' || current_run_id || ' ' || current_instance_id FROM runtime_control_state WHERE id=1;") || return 1
  [[ "$paused" == true || "$paused" == false ]] && [[ -n "$run" && -n "$instance" ]] || return 1
  sha="$(health_sha)" || return 1
  runtime="$(compose ps -q krabs-runtime)"; api="$(compose ps -q krabs-api)"; manager="$(compose ps -q krabs-runtime-manager)"
  [[ -n "$runtime" && -n "$api" && -n "$manager" ]] || return 1
  read_identity "$sha" || return 1
  high="$(baseline_high_water)"
  python3 - "$paused" "$run" "$instance" "$runtime" "$api" "$manager" "$high" <<'PY'
import json,sys
print(json.dumps({'prePaused':sys.argv[1]=='true','preRunId':sys.argv[2],'preInstanceId':sys.argv[3],
 'preRuntimeId':sys.argv[4],'preApiId':sys.argv[5],'preManagerId':sys.argv[6],
 'baselineCommandHighWater':int(sys.argv[7])},separators=(',',':')))
PY
}
deploy_command() {
  local action="$1" state_id="$2" target_sha="$3" expected="$4" initiator status paused attempt
  initiator="deploy:${state_id}:${target_sha}:${action}"
  sql "BEGIN IMMEDIATE; INSERT INTO operator_commands(action,reason,initiator_type,initiator,status,created_at) SELECT '$action','deploy controller','system','$initiator','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM operator_commands WHERE initiator='$initiator'); COMMIT;" >/dev/null
  for ((attempt=0; attempt<POLL_ATTEMPTS; attempt++)); do
    status="$(sql "SELECT status FROM operator_commands WHERE initiator='$initiator';")"
    paused="$(paused_status)" || return 1
    [[ "$status" == applied && "$paused" == "$expected" ]] && return 0
    [[ "$status" == rejected ]] && return 1
    sleep "$POLL_INTERVAL"
  done
  return 1
}
deploy_cutover() {
  local state_id="$1" high paused
  sql "BEGIN IMMEDIATE; INSERT INTO operator_commands(action,reason,initiator_type,initiator,status,created_at) SELECT 'pause','deploy controller','system','deploy:$state_id:pause','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM operator_commands WHERE initiator='deploy:$state_id:pause'); UPDATE operator_commands SET status='applied' WHERE initiator='deploy:$state_id:pause' AND status='pending'; UPDATE runtime_control_state SET paused=1 WHERE id=1; SELECT status FROM operator_commands WHERE initiator='deploy:$state_id:pause'; COMMIT;" | tail -1 | grep -qx applied || return 1
  paused="$(sql "SELECT CASE paused WHEN 1 THEN 'true' WHEN 0 THEN 'false' END FROM runtime_control_state WHERE id=1;")"
  [[ "$paused" == true ]] || return 1
  high="$(baseline_high_water)"
  python3 - "$high" <<'PY'
import json,sys
print(json.dumps({'effectivePaused':True,'cutoverCommandHighWater':int(sys.argv[1])},separators=(',',':')))
PY
}
deploy_cutoff_probe() {
  local before key
  before="$(baseline_high_water)"; key=test
  if [[ "${KRABS_ROLLBACK_TEST_MODE:-}" != 1 ]]; then
    [[ "${KRABS_RUNTIME_ENV_PATH:-}" == /opt/krabs/config/deploy-runtime-env-* && -f "$KRABS_RUNTIME_ENV_PATH" && "${KRABS_RUNTIME_ENV_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || return 1
    [[ "$(sha256sum "$KRABS_RUNTIME_ENV_PATH" | awk '{print $1}')" == "$KRABS_RUNTIME_ENV_SHA256" ]] || return 1
    key="$(sed -n 's/^KRABS_API_KEY=//p' "$KRABS_RUNTIME_ENV_PATH" | tail -1)"
  fi
  [[ -n "$key" ]] || return 1
  [[ "$("$CURL" --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 2 -X POST -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data '{"reason":"deploy cutoff probe"}' "$API_BASE/api/v1/actions/resume")" == 409 && "$before" == "$(baseline_high_water)" ]]
}
deploy_arbitrate() {
  local state_id="$1" pre="$2" baseline="$3" target_sha="$4" latest action effective high override=false
  local POLL_ATTEMPTS="${KRABS_DEPLOY_ARBITRATION_POLL_ATTEMPTS:-300}"
  [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] && read_identity "$target_sha" || return 1
  latest="$(sql "SELECT action FROM operator_commands WHERE initiator_type='operator' AND id > $baseline ORDER BY created_at ASC, id ASC;" | tail -n 1)"
  action=pause; [[ "$pre" == false ]] && action=resume
  [[ "$pre" == false && ( "$latest" == pause || "$latest" == resume ) ]] && action="$latest"; [[ "$latest" == pause ]] && override=true
  deploy_command "$action" "$state_id" "$target_sha" "$([[ "$action" == pause ]] && printf true || printf false)" || return 1
  effective="$(paused_status)" || return 1; high="$(baseline_high_water)"
  python3 - "$effective" "$high" "$action" "$override" <<'PY'
import json,sys
print(json.dumps({'effectivePaused':sys.argv[1]=='true','finalOperatorCommandHighWater':int(sys.argv[2]),'finalAction':sys.argv[3],'operatorPauseOverride':sys.argv[4]=='true'},separators=(',',':')))
PY
}
alert() {
  local code="$1" count="$2" target="$3" severity="$4"
  local labels; labels="$(python3 - "$code" "$count" "$target" "$severity" <<'PY'
import json,sys
print(json.dumps({"code":sys.argv[1],"severity":sys.argv[4],"source":"rollback-guard","message":"Rollback remains paused: multi-row token review required" if sys.argv[1]=="ROLLBACK_MULTIROW_REVIEW_REQUIRED" else "Rollback operation remains in progress","details":{"count":int(sys.argv[2]),"targetSha":sys.argv[3]}},separators=(",",":")))
PY
)"
  "$SQLITE" "$DATA_DIR/ledger-live-lite.db" "INSERT INTO runtime_metrics(metric_name,value,labels,captured_at) VALUES ('infra_alert',1,'${labels//\'/\'\'}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));" >/dev/null
}
restore() {
  local id pre target count action final_h effective
  [[ "$(state_field phase)" != restored ]] || { replay_receipt; return; }; id="$(state_field rollbackStateId)"; pre="$(state_field preRollbackPaused)"; target="$(state_field targetSha)"; count="$(multirow_count)"; [[ "$count" == 0 ]] || return 20
  action="$(settled_restore_action "$(state_field baselineCommandHighWater)" "$pre")" || return 1; ensure_command "$action" "$id" "$([[ "$action" == pause ]] && printf true || printf false)" || return 1
  action="$(settled_restore_action "$(state_field baselineCommandHighWater)" "$pre")" || return 1
  ensure_command "$action" "$id" "$([[ "$action" == pause ]] && printf true || printf false)" || return 1; effective="$(paused_status)" || return 1; final_h="$(baseline_high_water)"
  write_state "$(state_json | python3 -c 'import json,sys; d=json.load(sys.stdin); d.update(phase="restored",finalOperatorCommandHighWater=int(sys.argv[1]),effectivePaused=sys.argv[2]=="true"); print(json.dumps(d,separators=(",",":")))' "$final_h" "$effective")"
  replay_receipt
}
replay_receipt() {
  local effective action; effective="$(state_field effectivePaused)"; [[ "$(paused_status)" == "$effective" ]] || { action="$(settled_restore_action "$(state_field finalOperatorCommandHighWater)" "$effective")" || return 1; [[ "$action" == pause && "$(paused_status)" == true ]] || return 1; write_state "$(state_json | python3 -c 'import json,sys; d=json.load(sys.stdin); d.update(effectivePaused=True,finalOperatorCommandHighWater=int(sys.argv[1])); print(json.dumps(d,separators=(",",":")))' "$(baseline_high_water)")"; }; printf 'ROLLBACK_RECEIPT %s\n' "$(state_json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d[k] for k in ("rollbackStateId","originalSha","targetSha","preRollbackPaused","effectivePaused","finalOperatorCommandHighWater")},separators=(",",":")))')"; rm -f "$MARKER_PATH" "$STATE_FILE"
}
begin() {
  local target="$1" original id state
  is_sha "$target" || die "target SHA is invalid"; [[ ! -e "$STATE_FILE" && ! -e "$MARKER_PATH" ]] || die "rollback ownership already exists"; [[ ! -e "${KRABS_DEPLOY_RECOVERY_PATH:-/opt/krabs/config/deploy-recovery.json}" ]] || die "deploy recovery exists"
  paused_status >/dev/null || die "status is unavailable"; original="$(health_sha)" || die "health is unavailable"; read_identity "$original" || die "original app identity is not complete"
  id="$(python3 -c 'import uuid; print(uuid.uuid4())')"; state="$(python3 - "$id" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$original" "$target" <<'PY'
import json,sys
print(json.dumps({"schemaVersion":1,"rollbackStateId":sys.argv[1],"phase":"arming","preRollbackPaused":None,"startedAt":sys.argv[2],"originalSha":sys.argv[3],"targetSha":sys.argv[4],"baselineCommandHighWater":0},separators=(",",":")))
PY
)"
  write_state "$state"; write_marker_from_state
  finish_arming || die "rollback arming did not complete"
}
finalize() {
  local target="$1" phase count
  read_state_or_die; [[ "$target" == "$(state_field targetSha)" ]] || die "target SHA does not match state"; phase="$(state_field phase)"; [[ "$phase" == prepared || "$phase" == deploying || "$phase" == restored ]] || die "rollback cannot finalize in phase $phase"; read_identity "$target" || { alert ROLLBACK_OPERATION_IN_PROGRESS 0 "$target" warning || true; return 1; }; [[ "$phase" != restored ]] || { replay_receipt; return; }
  update_phase deploying; write_marker_from_state; count="$(multirow_count)"; [[ "$count" == 0 ]] || { update_phase blocked; write_marker_from_state; alert ROLLBACK_MULTIROW_REVIEW_REQUIRED "$count" "$target" error; return 20; }
  restore
}
abort() {
  read_state_or_die; [[ "$(state_field phase)" == prepared ]] || die "only prepared rollback can abort"
  read_identity "$(state_field originalSha)" || { alert ROLLBACK_OPERATION_IN_PROGRESS 0 "$(state_field targetSha)" warning || true; return 1; }
  restore
}
watch() {
  [[ -e "$STATE_FILE" || -e "$MARKER_PATH" ]] || return 0
  read_state_or_die
  local phase target count
  phase="$(state_field phase)"; target="$(state_field targetSha)"
  if [[ "$phase" == arming ]]; then
    if [[ ! -e "$MARKER_PATH" ]]; then arming_without_marker && rm -f "$STATE_FILE"; return $?; fi
    finish_arming; return
  fi
  if [[ "$phase" == restored ]]; then read_identity "$target" || return 1; replay_receipt; return; fi
  if read_identity "$target"; then
    [[ "$phase" == prepared ]] && { update_phase deploying; write_marker_from_state; }
    count="$(multirow_count)"; if [[ "$count" != 0 ]]; then update_phase blocked; write_marker_from_state; alert ROLLBACK_MULTIROW_REVIEW_REQUIRED "$count" "$target" error; return 20; fi
    restore; return 0
  fi
  ensure_command pause "$(state_field rollbackStateId)" true || true
  alert ROLLBACK_OPERATION_IN_PROGRESS 0 "$target" warning || true
  return 1
}
status() {
  [[ -e "$STATE_FILE" ]] || { printf 'ROLLBACK_STATUS_NONE\n'; return 0; }
  read_state_or_die; local count; count="$(multirow_count)"
  state_json | python3 -c 'import json,sys; d=json.load(sys.stdin); d["multirowCount"]=int(sys.argv[1]); keep=("schemaVersion","rollbackStateId","phase","preRollbackPaused","startedAt","originalSha","targetSha","baselineCommandHighWater","multirowCount"); print("ROLLBACK_STATUS "+json.dumps({k:d[k] for k in keep},separators=(",",":")))' "$count"
}
install_service() {
  install -d -m 700 "$STATE_DIR"; install -d -m 755 "$UNIT_DIR" "$(dirname "$INSTALL_BIN")"; install -m 755 "$0" "$INSTALL_BIN"
  cat > "$UNIT_DIR/krabs-rollback-guard.service" <<EOF
[Service]
Type=oneshot
ExecStart=$INSTALL_BIN watch
TimeoutStartSec=90s
[Install]
WantedBy=multi-user.target
EOF
  cat > "$UNIT_DIR/krabs-rollback-guard.timer" <<'EOF'
[Timer]
OnBootSec=1min
OnUnitActiveSec=30min
Persistent=true
[Install]
WantedBy=timers.target
EOF
  cat > "$UNIT_DIR/krabs-deploy-failstop.service" <<EOF
[Service]
Type=oneshot
ExecStart=$INSTALL_BIN deploy-watch
After=docker.service
TimeoutStartSec=20s
[Install]
WantedBy=multi-user.target
EOF
  cat > "$UNIT_DIR/krabs-deploy-failstop.timer" <<'EOF'
[Timer]
OnBootSec=2s
OnUnitActiveSec=5s
AccuracySec=1s
RandomizedDelaySec=0
Persistent=true
[Install]
WantedBy=timers.target
EOF
  "$SYSTEMCTL" daemon-reload; "$SYSTEMCTL" enable --now krabs-rollback-guard.timer krabs-deploy-failstop.timer
}
deploy_watch() {
  [[ -e "$DEPLOY_RECOVERY" ]] || return 0
  local phase owner ticks state target worker_pgid disposition watchdog_pgid
  read -r phase owner ticks state target worker_pgid disposition < <(python3 - "$DEPLOY_RECOVERY" "$DEPLOY_META" "$DEPLOY_SENTINEL" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); required={'schemaVersion','recoveryStateId','phase','deliveryMode','targetSha','controllerPid','controllerStartTicks','tradingCutoverInvoked','prePaused','preRunId','preInstanceId','previousVersion','baselineCapturedUnderLock','baselineCommandHighWater','finalCommandHighWater','targetRuntimeId','targetManagerId','targetNetworkIds','restartPolicies','candidateHash','receipt','runtimeEnvPath','runtimeEnvSha256'}
assert d.get('schemaVersion')==1 and required <= set(d) and d['deliveryMode'] in ('release','rollback')
assert isinstance(d['controllerPid'],int) and d['controllerPid']>0 and isinstance(d['controllerStartTicks'],str)
assert d['phase'] in ('rollback_bound','rollback_bound_owner_dead','prepared','baseline_captured','fenced','cutover_paused','migration_gate_pre','target_started','arbitration_boundary','commit_ready','committed_unacknowledged','target_stopped_rearbitrate')
pgid=d.get('workerPgid',0); assert isinstance(pgid,int) and pgid>=0
advanced=False
if d['phase'] in ('commit_ready','committed_unacknowledged') and d['receipt']:
 try:
  m=json.load(open(sys.argv[2])); r=json.loads(d['receipt'])
  advanced=(m.get('sha')==d['targetSha'] and m.get('recoveryStateId')==d['recoveryStateId'] and m.get('deployVersion')==d['previousVersion']+1 and m.get('digest')==d.get('digest') and m.get('runtimeEnvSha256')==d.get('runtimeEnvSha256') and m.get('receipt')==r and r.get('recoveryStateId')==d['recoveryStateId'])
 except FileNotFoundError: pass
if advanced: c='committed-unacknowledged'
elif d['phase']=='commit_ready': c='commit_ready@previous'
elif d['phase']=='target_stopped_rearbitrate': c='target_stopped_rearbitrate'
elif d['phase'] in ('baseline_captured','fenced','cutover_paused','migration_gate_pre'): c='early_recovery'
elif d['phase'] in ('target_started','arbitration_boundary'): c='arbitration_boundary'
elif d['phase'] in ('rollback_bound','rollback_bound_owner_dead'): c=d['phase']
elif open(sys.argv[3]).read().strip()==d['recoveryStateId'] if __import__('os').path.exists(sys.argv[3]) else False: c='already-fenced'
else: c='normal'
print(d['phase'],d['controllerPid'],d['controllerStartTicks'] or '-',d['recoveryStateId'],d['targetSha'],pgid,c)
PY
) || die "deploy recovery is malformed"
  [[ -r "/proc/$owner/stat" && "$(awk '{print $22}' "/proc/$owner/stat" 2>/dev/null)" == "$ticks" ]] && return 0
  atomic_write "$DEPLOY_SENTINEL" "$state"; chmod 600 "$DEPLOY_SENTINEL"
  exec {fail_fd}>"$FAILSTOP_LOCK"; "$FLOCK" --exclusive --nonblock "$fail_fd" || return 1
  watchdog_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
  if [[ -n "$watchdog_pgid" && "$worker_pgid" != 0 && "$worker_pgid" != "$watchdog_pgid" ]]; then kill -TERM -- "-$worker_pgid" 2>/dev/null || true; sleep 1; kill -KILL -- "-$worker_pgid" 2>/dev/null || true; fi
  if [[ "$disposition" == rollback_bound || "$disposition" == rollback_bound_owner_dead ]]; then
    read_state_or_die
    [[ "$(state_field phase)" == prepared && "$(state_field rollbackStateId)" == "$state" && "$(state_field targetSha)" == "$target" ]] || die "rollback binding is not exact"
    exec {deploy_fd}>"$DEPLOY_LOCK"; "$FLOCK" --exclusive --nonblock "$deploy_fd" || return 1
    exec {op_fd}>"$LOCK_FILE"; "$FLOCK" --exclusive --nonblock "$op_fd" || return 1
    [[ "$disposition" == rollback_bound_owner_dead ]] || atomic_write "$DEPLOY_RECOVERY" "$(python3 - "$DEPLOY_RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));d['phase']='rollback_bound_owner_dead';print(json.dumps(d,separators=(',',':')))
PY
)"
    rm -f "$DEPLOY_SENTINEL" "$DEPLOY_RECOVERY"
    return 0
  fi
  [[ "$disposition" == early_recovery ]] && return 0
  local runtime manager; read -r runtime manager < <(deploy_targets); [[ -n "$runtime" && -n "$manager" ]] || die 'deploy target ids are unavailable'
  if [[ "$disposition" == committed-unacknowledged ]]; then
    "$DOCKER" update --restart=unless-stopped "$runtime" "$manager"
    atomic_write "$DEPLOY_RECOVERY" "$(python3 - "$DEPLOY_RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['phase']='committed_unacknowledged'; print(json.dumps(d,separators=(',',':')))
PY
)"
    return 0
  fi
  "$DOCKER" update --restart=no "$runtime" "$manager"
  "$DOCKER" stop --time 1 "$manager"; "$DOCKER" stop --time 1 "$runtime"
  for id in "$runtime" "$manager"; do [[ "$("$DOCKER" inspect --format '{{.State.Running}}' "$id")" == false ]] || die "target did not stop"; done
  atomic_write "$DEPLOY_RECOVERY" "$(python3 - "$DEPLOY_RECOVERY" "$disposition" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));d['phase']='target_stopped_rearbitrate' if d['targetNetworkIds'] else 'baseline_captured';d['recoveryDisposition']=sys.argv[2];print(json.dumps(d,separators=(',',':')))
PY
)"
}
deploy_targets() {
  local runtime manager
  read -r runtime manager < <(python3 - "$DEPLOY_RECOVERY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print(d.get('targetRuntimeId',''),d.get('targetManagerId',''))
PY
)
  [[ -n "$runtime" ]] || runtime="$(compose ps -q krabs-runtime)"; [[ -n "$manager" ]] || manager="$(compose ps -q krabs-runtime-manager)"; [[ "$runtime" != *$'\n'* && "$manager" != *$'\n'* ]] && printf '%s %s\n' "$runtime" "$manager"
}
ordinary() {
  if [[ "${KRABS_DEPLOY_OPERATION_OWNER:-}" != 1 && "$1" != status && "$1" != install-service ]]; then mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"; exec {deploy_fd}>"$DEPLOY_LOCK"; "$FLOCK" --exclusive --nonblock "$deploy_fd" || die "deploy operation in progress"; exec {op_fd}>"$LOCK_FILE"; "$FLOCK" --exclusive --nonblock "$op_fd" || die "rollback operation in progress"; fi
  case "$1" in
    begin) begin "$2" ;;
    finalize) finalize "$2" ;;
    watch) watch ;;
    abort) abort ;;
    status) status ;;
    install-service) install_service ;;
    deploy-baseline) deploy_baseline ;;
    deploy-cutover) deploy_cutover "$2" ;;
    deploy-arbitrate) [[ $# == 5 ]] || die "deploy-arbitrate requires state, pause baseline, command high-water, and full target SHA"; deploy_arbitrate "$2" "$3" "$4" "$5" ;;
    deploy-cutoff-probe) deploy_cutoff_probe "$2" ;;
    *) die "unknown rollback command" ;;
  esac
}
main() {
  configure; local command="${1:-}"
  [[ -n "$command" ]] || die "usage: $0 {begin|finalize|watch|abort|status|install-service|deploy-baseline|deploy-cutover|deploy-arbitrate|deploy-cutoff-probe|deploy-watch}"
  if [[ "$command" == deploy-watch ]]; then [[ "${KRABS_DEPLOY_WATCH_INTERNAL:-}" == 1 ]] || exec env KRABS_DEPLOY_WATCH_INTERNAL=1 "$TIMEOUT_BIN" --signal=TERM --kill-after=2s 15s "$0" "$@"; deploy_watch; return; fi
  local command_timeout="$COMMAND_TIMEOUT"
  [[ "$command" != deploy-arbitrate ]] || command_timeout="${KRABS_DEPLOY_ARBITRATION_TIMEOUT_SECONDS:-630}"
  [[ "${KRABS_ROLLBACK_INTERNAL:-}" == 1 ]] || exec env KRABS_ROLLBACK_INTERNAL=1 "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${command_timeout}s" "$0" "$@"
  ordinary "$@"
}
main "$@"
