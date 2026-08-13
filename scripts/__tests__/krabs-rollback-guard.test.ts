import { afterEach, beforeEach, describe, expect, it } from "vitest";
// prettier-ignore
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../..", import.meta.url));
const guard = join(root, "scripts", "krabs-rollback-guard.sh");
const deploy = join(root, "deploy.sh");
const original = "a".repeat(40);
const target = "b".repeat(40);
const dirs: string[] = [];
type Fixture = ReturnType<typeof makeFixture>;
function sql(path: string, statement: string) {
  const result = spawnSync("/usr/bin/sqlite3", [path, statement], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
// prettier-ignore
function executable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`); chmodSync(path, 0o755);
}
// prettier-ignore
function state(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.stateDir, "state.json"), "utf8"));
}
// prettier-ignore
function targetReady(fixture: Fixture) {
  writeFileSync(fixture.identity, target); writeFileSync(fixture.health, target);
}
// prettier-ignore
function begin(fixture: Fixture, sha = target) {
  expect(run(fixture, "begin", sha).status).toBe(0);
}
// prettier-ignore
function addMultirow(fixture: Fixture) {
  sql(fixture.control, "INSERT INTO positions(token_id,status) VALUES ('same','open'),('same','dust')"); targetReady(fixture);
}
function makeFixture(paused = false) {
  const dir = mkdtempSync(join(tmpdir(), "krabs-rollback-guard-"));
  dirs.push(dir);
  // prettier-ignore
  const stateDir=join(dir,"state"), marker=join(dir,"rollback.json"), control=join(dir,"control.db"), data=join(dir,"data"), ledger=join(data,"ledger-live-lite.db"), api=join(dir,"api-state"), available=join(dir,"api-available"), identity=join(dir,"identity"), health=join(dir,"health-identity"), calls=join(dir,"calls"), sqlite=join(dir,"sqlite"), curl=join(dir,"curl"), docker=join(dir,"docker"), flock=join(dir,"flock"), systemctl=join(dir,"systemctl"), installBin=join(dir,"install","guard"), units=join(dir,"units"), fenced=join(dir,"network-fenced");
  mkdirSync(data);
  sql(
    control,
    `CREATE TABLE operator_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, reason TEXT, initiator_type TEXT NOT NULL DEFAULT 'operator', initiator TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, applied_at TEXT); CREATE TABLE positions (token_id TEXT NOT NULL, status TEXT NOT NULL); CREATE TABLE runtime_control_state (id INTEGER PRIMARY KEY, paused INTEGER, current_run_id TEXT, current_instance_id TEXT); INSERT INTO runtime_control_state VALUES (1,${paused ? 1 : 0},'run-before','instance-before');`,
  );
  sql(
    ledger,
    "CREATE TABLE runtime_metrics (id INTEGER PRIMARY KEY, metric_name TEXT, value REAL, labels TEXT, captured_at TEXT);",
  );
  writeFileSync(api, paused ? "true" : "false");
  writeFileSync(available, "yes");
  writeFileSync(identity, original);
  writeFileSync(health, original);
  writeFileSync(calls, "");
  executable(
    sqlite,
    `echo "sqlite $*" >> "$CALLS"\n[[ "\${CUTOFF_WRITER:-}" == 1 && "\${2:-}" == *"BEGIN IMMEDIATE; SELECT coalesce(max(id),0) FROM operator_commands; COMMIT;"* ]] && /usr/bin/sqlite3 "$1" "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:00.000Z');"\n[[ "\${ARBITRATION_PAUSE:-}" == 1 && "\${2:-}" == *"SELECT action || '|' || status"* && "$(/usr/bin/sqlite3 "$1" "SELECT count(*) FROM operator_commands WHERE initiator LIKE 'rollback:%:resume';")" == 1 ]] && { /usr/bin/sqlite3 "$1" "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:01.000Z');"; echo true > "$API_STATE"; }\n/usr/bin/sqlite3 "$@"\nif [[ "\${2:-}" == *"INSERT INTO operator_commands"* ]]; then action=$(/usr/bin/sqlite3 "$1" "SELECT action FROM operator_commands WHERE status='pending' ORDER BY id DESC LIMIT 1;"); /usr/bin/sqlite3 "$1" "UPDATE operator_commands SET status='applied' WHERE status='pending';"; [[ "$action" == pause ]] && echo true > "$API_STATE"; [[ "$action" == resume ]] && echo false > "$API_STATE"; fi\ntrue`,
  );
  executable(
    curl,
    `echo "curl $*" >> "$CALLS"\n[[ -e "$API_AVAILABLE" ]] || exit 7\nurl="\${@: -1}"\ncase "\${CURL_MODE:-}" in\ntransport) exit 7 ;;\nstatus-malformed) [[ "$url" == */status ]] && { printf 'not-json\\n'; exit 0; } ;;\nstatus-missing) [[ "$url" == */status ]] && { printf '{"ok":true}\\n'; exit 0; } ;;\nstatus-null) [[ "$url" == */status ]] && { printf '{"ok":true,"data":{"paused":null}}\\n'; exit 0; } ;;\nstatus-string) [[ "$url" == */status ]] && { printf '{"ok":true,"data":{"paused":"false"}}\\n'; exit 0; } ;;\nhealth-malformed) [[ "$url" == */health ]] && { printf '{"ok":true,"data":{"sha":null}}\\n'; exit 0; } ;;\nhealth-mismatch) [[ "$url" == */health ]] && { printf '{"ok":true,"data":{"sha":"cccccccccccccccccccccccccccccccccccccccc"}}\\n'; exit 0; } ;;\nesac\n[[ "$url" == */actions/resume ]] && { printf 409; exit 0; }; [[ "$url" == */health ]] && printf '{"ok":true,"data":{"sha":"%s"}}\\n' "$(cat "$HEALTH_IDENTITY")" || printf '{"ok":true,"data":{"paused":%s}}\\n' "$(cat "$API_STATE")"`,
  );
  executable(
    docker,
    `echo "docker $*" >> "$CALLS"\n[[ "\${DOCKER_HANG:-}" == 1 ]] && sleep 5\n[[ "\${DOCKER_MODE:-}" == compose-nonzero && "$1" == compose ]] && exit 9\nif [[ "$1" == compose ]]; then [[ "\${DOCKER_MODE:-}" == missing && "$4" == krabs-api ]] && exit 0; printf '%s\\n' "id-$4"; exit 0; fi\nif [[ "$1" == network && "$2" == disconnect ]]; then : > "$NETWORK_FENCED"; exit 0; fi\nif [[ "$1" == inspect && "$*" == *NetworkSettings.Networks* ]]; then [[ -e "$NETWORK_FENCED" ]] && printf '{}\\n' || printf '{"krabs_default":{}}\\n'; exit 0; fi\n[[ "\${DOCKER_MODE:-}" == inspect-nonzero && "$1" == inspect ]] && exit 8\nif [[ "$1" == inspect && "$*" == *State.Running* && -e "$STOPPED" ]]; then [[ "$*" == *org.opencontainers.image.revision* ]] && printf 'false %s\\n' "$(cat "$IDENTITY")" || printf 'false\\n'; exit 0; fi\nif [[ "$1" == inspect && "$*" == *State.Running* ]]; then [[ "\${DOCKER_MODE:-}" == stopped ]] && { printf 'false %s\\n' "$(cat "$IDENTITY")"; exit 0; }; [[ "\${DOCKER_MODE:-}" == bad-label ]] && { printf 'true cccccccccccccccccccccccccccccccccccccccc\\n'; exit 0; }; [[ "\${DOCKER_MODE:-}" == mixed && "$*" == *id-krabs-api* ]] && { printf 'true cccccccccccccccccccccccccccccccccccccccc\\n'; exit 0; }; fi\n[[ "$1" == stop ]] && { : > "$STOPPED"; exit 0; }\nprintf 'true %s\\n' "$(cat "$IDENTITY")"`,
  );
  executable(
    flock,
    `echo "flock $*" >> "$CALLS"\n[[ "$1" == --exclusive && "$2" == --nonblock ]] || exit 64\nexec /usr/bin/perl -MFcntl=:flock -e 'open(my $fh, ">&=$ARGV[0]") or exit 2; flock($fh, LOCK_EX|LOCK_NB) or exit 1' "$3"`,
  );
  executable(systemctl, `echo "systemctl $*" >> "$CALLS"`);
  // prettier-ignore
  const env = { ...process.env, KRABS_ROLLBACK_TEST_MODE: "1", KRABS_ROLLBACK_STATE_DIR: stateDir, KRABS_ROLLBACK_MARKER_PATH: marker, KRABS_ROLLBACK_CONTROL_DB_PATH: control, KRABS_ROLLBACK_DATA_DIR: data, KRABS_ROLLBACK_SQLITE: sqlite, KRABS_ROLLBACK_CURL: curl, KRABS_ROLLBACK_DOCKER: docker, KRABS_ROLLBACK_FLOCK: flock, KRABS_ROLLBACK_SYSTEMCTL: systemctl, KRABS_ROLLBACK_INSTALL_BIN: installBin, KRABS_ROLLBACK_UNIT_DIR: units, KRABS_ROLLBACK_TIMEOUT_BIN: "timeout", KRABS_ROLLBACK_POLL_ATTEMPTS: "2", KRABS_ROLLBACK_POLL_INTERVAL_SECONDS: "0", KRABS_DEPLOY_LOCK_PATH: join(dir, "deploy.lock"), CALLS: calls, API_STATE: api, API_AVAILABLE: available, IDENTITY: identity, HEALTH_IDENTITY: health, NETWORK_FENCED: fenced, STOPPED: join(dir, "stopped") };
  // prettier-ignore
  return { dir, stateDir, marker, control, data, ledger, api, available, identity, health, calls, installBin, units, env };
}
// prettier-ignore
function run(fixture: Fixture,...args: string[]) { const result=spawnSync(guard,args,{env:fixture.env,encoding:"utf8",timeout:10_000}); if(result.error) throw new Error(`${result.error.message}\n${result.stderr}`); return result; }
// prettier-ignore
function rows(fixture: Fixture) { return JSON.parse(sql(fixture.control,"SELECT json_group_array(json_object('action',action,'initiator_type',initiator_type,'initiator',initiator,'status',status)) FROM operator_commands ORDER BY id;") || "[]"); }
// prettier-ignore
function untouchedBegin(fixture: Fixture, paused: boolean) { expect(existsSync(join(fixture.stateDir,"state.json"))).toBe(false); expect(existsSync(fixture.marker)).toBe(false); expect(readFileSync(fixture.api,"utf8").trim()).toBe(String(paused)); expect(rows(fixture)).toEqual([]); expect(sql(fixture.ledger,"SELECT count(*) FROM runtime_metrics;")).toBe("0"); }
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const yieldToWorker = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(yieldToWorker);
describe("krabs rollback guard", () => {
  // prettier-ignore
  it("T28a — authoritative intent, cutoff, and receipt lifecycle", async () => { const fixture=makeFixture(false); begin(fixture); const rollback=state(fixture); expect(rollback.phase).toBe("prepared"); expect(rollback.preRollbackPaused).toBe(false); expect(rollback.baselineCommandHighWater).toBeLessThan(1); expect(JSON.parse(readFileSync(fixture.marker,"utf8")).rollbackStateId).toBe(rollback.rollbackStateId); targetReady(fixture); const finalize=run(fixture,"finalize",target); expect(finalize.status).toBe(0); expect(finalize.stdout).toContain("ROLLBACK_RECEIPT"); expect(readFileSync(fixture.api,"utf8").trim()).toBe("false"); expect(rows(fixture)).toMatchObject([{action:"pause",initiator_type:"system",initiator:`rollback:${rollback.rollbackStateId}:pause`,status:"applied"},{action:"resume",initiator_type:"system",initiator:`rollback:${rollback.rollbackStateId}:resume`,status:"applied"}]); expect(existsSync(fixture.marker)).toBe(false); expect(run(fixture,"status").stdout.trim()).toBe("ROLLBACK_STATUS_NONE"); await yieldToWorker(); t28aCutoff(); await yieldToWorker(); t28aEdges(); },90_000);
  // prettier-ignore
  const t28aCutoff = () => { const fixture=makeFixture(false); (fixture.env as Record<string,string|undefined>).CUTOFF_WRITER="1"; begin(fixture); const rollback=state(fixture); expect(rollback.baselineCommandHighWater).toBe(1); expect(readFileSync(fixture.calls,"utf8")).toContain("BEGIN IMMEDIATE; SELECT coalesce(max(id),0) FROM operator_commands; COMMIT;"); sql(fixture.control,"INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:00.000Z')"); writeFileSync(fixture.api,"true"); targetReady(fixture); expect(run(fixture,"finalize",target).status).toBe(0); expect(readFileSync(fixture.api,"utf8").trim()).toBe("true"); expect(rows(fixture).filter((row:{action:string})=>row.action==="resume")).toHaveLength(0); };
  // prettier-ignore
  const t28aEdges = () => { const absent=makeFixture(false); begin(absent); const inert=state(absent); inert.phase="arming"; writeFileSync(join(absent.stateDir,"state.json"),JSON.stringify(inert)); rmSync(absent.marker); sql(absent.control,"DELETE FROM operator_commands"); writeFileSync(absent.api,"false"); expect(run(absent,"watch").status).toBe(0); expect(existsSync(join(absent.stateDir,"state.json"))).toBe(false); const marked=makeFixture(false); begin(marked); const arming=state(marked), marker=JSON.parse(readFileSync(marked.marker,"utf8")); arming.phase=marker.phase="arming"; writeFileSync(join(marked.stateDir,"state.json"),JSON.stringify(arming)); writeFileSync(marked.marker,JSON.stringify(marker)); const continued=run(marked,"watch"); if(continued.status) throw new Error(readFileSync(marked.calls,"utf8")); expect(state(marked).phase).toBe("prepared"); sql(marked.control,"UPDATE operator_commands SET initiator_type='operator' WHERE initiator LIKE 'rollback:%:pause'"); targetReady(marked); expect(run(marked,"finalize",target).status).not.toBe(0); const early=makeFixture(false); begin(early); const earlyState=state(early); sql(early.control,`INSERT INTO operator_commands(action,initiator_type,initiator,status,created_at) VALUES ('resume','system','rollback:${earlyState.rollbackStateId}:resume','applied','2026-01-01T00:00:00.000Z')`); targetReady(early); expect(run(early,"finalize",target).status).not.toBe(0); const replay=makeFixture(false); begin(replay); targetReady(replay); const restored=state(replay); Object.assign(restored,{phase:"restored",finalOperatorCommandHighWater:1,effectivePaused:false}); sql(replay.control,"INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:00.000Z')"); writeFileSync(join(replay.stateDir,"state.json"),JSON.stringify(restored)); const replayReceipt=run(replay,"finalize",target); expect(JSON.parse(replayReceipt.stdout.replace("ROLLBACK_RECEIPT ",""))).toMatchObject({effectivePaused:true,finalOperatorCommandHighWater:2}); expect(existsSync(join(replay.stateDir,"state.json"))).toBe(false); const boundary=makeFixture(false); begin(boundary); targetReady(boundary); (boundary.env as Record<string,string|undefined>).ARBITRATION_PAUSE="1"; const receipt=run(boundary,"finalize",target); expect(receipt.status).toBe(0); expect(JSON.parse(receipt.stdout.replace("ROLLBACK_RECEIPT ","")).finalOperatorCommandHighWater).toBe(Number(sql(boundary.control,"SELECT max(id) FROM operator_commands;"))); };
  // prettier-ignore
  it("T28b — multirow incident ownership and installable timers", () => { const fixture=makeFixture(true); expect(run(fixture,"install-service").status).toBe(0); expect(existsSync(fixture.installBin)).toBe(true); expect(readFileSync(join(fixture.units,"krabs-deploy-failstop.timer"),"utf8")).toContain("OnUnitActiveSec=5s"); expect(readFileSync(join(fixture.units,"krabs-deploy-failstop.service"),"utf8")).toContain("deploy-watch"); begin(fixture); addMultirow(fixture); expect(run(fixture,"finalize",target).status).toBe(20); expect(state(fixture).phase).toBe("blocked"); const [labels,captured_at]=sql(fixture.ledger,"SELECT labels || '|' || captured_at FROM runtime_metrics WHERE metric_name='infra_alert';").split("|"); const alert={labels:labels!,captured_at:captured_at!}; expect(JSON.parse(alert.labels)).toMatchObject({code:"ROLLBACK_MULTIROW_REVIEW_REQUIRED",details:{count:1,targetSha:target}}); expect(alert.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); },90_000);
  // prettier-ignore
  it("T28c — blocked incident heartbeats and safe restoration", () => { const fixture=makeFixture(false); begin(fixture); addMultirow(fixture); expect(run(fixture,"watch").status).toBe(20); expect(run(fixture,"watch").status).toBe(20); expect(sql(fixture.ledger,"SELECT count(*) FROM runtime_metrics;")).toBe("2"); sql(fixture.control,"DELETE FROM positions"); expect(run(fixture,"watch").status).toBe(0); expect(readFileSync(fixture.api,"utf8").trim()).toBe("false"); }, 20_000);
  // prettier-ignore
  it("T28d — negative ownership, identity, and state matrix", () => { const fixture=makeFixture(false); writeFileSync(fixture.identity,"c".repeat(40)); writeFileSync(fixture.health,original); expect(run(fixture,"begin",target).status).not.toBe(0); expect(existsSync(join(fixture.stateDir,"state.json"))).toBe(false); expect(existsSync(fixture.marker)).toBe(false); writeFileSync(fixture.identity,original); writeFileSync(fixture.health,original); begin(fixture); writeFileSync(fixture.identity,"c".repeat(40)); expect(run(fixture,"finalize",target).status).not.toBe(0); expect(JSON.parse(readFileSync(join(fixture.stateDir,"state.json"),"utf8")).phase).toBe("prepared"); expect(readFileSync(fixture.api,"utf8").trim()).toBe("true"); t28dMatrix(); t28dState(); },90_000);
  // prettier-ignore
  const t28dMatrix=()=>{ const cases=[{name:"status transport",env:{CURL_MODE:"transport"}},{name:"status malformed",env:{CURL_MODE:"status-malformed"}},{name:"status missing envelope",env:{CURL_MODE:"status-missing"}},{name:"status paused null",env:{CURL_MODE:"status-null"}},{name:"status paused string",env:{CURL_MODE:"status-string"}},{name:"health malformed",env:{CURL_MODE:"health-malformed"}},{name:"health mismatched",env:{CURL_MODE:"health-mismatch"}},{name:"compose nonzero",env:{DOCKER_MODE:"compose-nonzero"}},{name:"inspect nonzero",env:{DOCKER_MODE:"inspect-nonzero"}},{name:"mixed target/api original",env:{DOCKER_MODE:"mixed"}},{name:"missing container",env:{DOCKER_MODE:"missing"}},{name:"stopped container",env:{DOCKER_MODE:"stopped"}},{name:"bad revision label",env:{DOCKER_MODE:"bad-label"}}] as const; for(const paused of [false,true]) for(const row of cases) { const fixture=makeFixture(paused),result=spawnSync(guard,["begin",target],{env:{...fixture.env,...row.env},encoding:"utf8",timeout:10_000}); expect(result.status,`${row.name} paused=${paused}`).not.toBe(0); untouchedBegin(fixture,paused); } };
  // prettier-ignore
  const t28dState=()=>{ const fixture=makeFixture(false); expect(run(fixture,"begin",target).status).toBe(0); const prepared=readFileSync(join(fixture.stateDir,"state.json"),"utf8"); expect(run(fixture,"finalize",original).status).not.toBe(0); expect(readFileSync(join(fixture.stateDir,"state.json"),"utf8")).toBe(prepared); expect(run(fixture,"abort").status).toBe(0); expect(existsSync(join(fixture.stateDir,"state.json"))).toBe(false); expect(run(fixture,"watch").status).toBe(0); const blocked=makeFixture(false); begin(blocked); addMultirow(blocked); expect(run(blocked,"watch").status).toBe(20); const before=readFileSync(join(blocked.stateDir,"state.json"),"utf8"); expect(run(blocked,"abort").status).not.toBe(0); expect(readFileSync(join(blocked.stateDir,"state.json"),"utf8")).toBe(before); };
  // prettier-ignore
  it("T28e — kernel lock ordering and timeout release", async () => { const fixture=makeFixture(false),lock=join(fixture.stateDir,"operation.lock"); mkdirSync(fixture.stateDir); const holder=spawn("/usr/bin/perl",["-MFcntl=:flock","-e","open(my $fh, '>', $ARGV[0]) or die; flock($fh, LOCK_EX) or die; sleep 1",lock]); await new Promise(resolve=>setTimeout(resolve,100)); expect(run(fixture,"watch").status).not.toBe(0); await new Promise<void>(resolve=>holder.on("exit",()=>resolve())); expect(run(fixture,"watch").status).toBe(0); expect(readFileSync(fixture.calls,"utf8")).toContain("flock --exclusive --nonblock"); t28eTimeout(); },40_000);
  // prettier-ignore
  const t28eTimeout = () => { const fixture=makeFixture(false); begin(fixture); const before=readFileSync(join(fixture.stateDir,"state.json"),"utf8"); const timed=spawnSync(guard,["watch"],{env:{...fixture.env,DOCKER_HANG:"1",KRABS_ROLLBACK_COMMAND_TIMEOUT_SECONDS:"1"},encoding:"utf8",timeout:10_000}); expect(timed.status).toBe(124); expect(readFileSync(join(fixture.stateDir,"state.json"),"utf8")).toBe(before); expect(readFileSync(fixture.api,"utf8").trim()).toBe("true"); expect(run(fixture,"status").status).toBe(0); };
  // prettier-ignore
  it("T28f — controller failure, intent arbitration, and API cutover", async () => { t28fIntent(); await t28fController(); },150_000);
  // prettier-ignore
  const t28fIntent = () => { const cases = [{ stage: "precommit", commands: [] as string[], expected: "resume" }, { stage: "commit_ready pause dominates", commands: ["pause"], expected: "pause" }, { stage: "after receipt pause then resume folds", commands: ["pause", "resume"], expected: "resume" }]; for (const row of cases) { const fixture = makeFixture(false); sql(fixture.control, "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2000-01-01T00:00:00.000Z')"); for (const [index, action] of row.commands.entries()) sql(fixture.control, `INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('${action}','operator','applied','2026-01-01T00:00:0${index}.000Z')`); const receipt = run(fixture, "deploy-arbitrate", "state", "false", "1"); expect(receipt.status, row.stage).toBe(0); expect(JSON.parse(receipt.stdout).finalAction, row.stage).toBe(row.expected); expect(readFileSync(fixture.api, "utf8").trim(), row.stage).toBe(String(row.expected === "pause")); } };
  const t28fController = async () => {
    const reached = new Set<string>(),
      fixture = makeFixture(true),
      deployTarget = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      config = join(fixture.dir, "config"),
      adapter = join(fixture.dir, "deploy-adapter"),
      remoteRoot = join(fixture.dir, "remote"),
      remoteBin = join(fixture.dir, "remote-bin"),
      digest = "d".repeat(64);
    mkdirSync(config);
    mkdirSync(join(remoteRoot, "config"), { recursive: true });
    mkdirSync(remoteBin);
    executable(
      adapter,
      `echo "$*" >> "$CALLS"; shift
case "$1" in
  compose) [[ "$*" == *" stop krabs-api"* ]] && rm -f "$API_AVAILABLE"; [[ "$*" == *" create "* ]] && rm -f "$NETWORK_FENCED"; [[ "$*" == *" up -d --no-deps krabs-api"* ]] && : > "$API_AVAILABLE"; [[ "$*" == *" ps --all -q "* ]] && echo "id-\${@: -1}"; exit 0 ;;
  build|pull|tag|update) exit 0 ;;
  stop) : > "$STOPPED"; exit 0 ;;
  start) rm -f "$STOPPED"; exit 0 ;;
  network) [[ "$2" == connect && "\${NETWORK_MODE:-}" != zero-after-connect ]] && rm -f "$NETWORK_FENCED" || : > "$NETWORK_FENCED"; exit 0 ;;
  push) echo "digest: \${DEPLOY_DIGEST:-sha256:${digest}}"; exit 0 ;;
  image) [[ "$*" == *revision* ]] && echo '${deployTarget}' || echo sha256:image; exit 0 ;;
  inspect) [[ "$*" == *NetworkSettings.Networks* ]] && { [[ "\${NETWORK_MODE:-}" == multi ]] && echo '{"krabs_default":{},"unexpected":{}}' || [[ "\${NETWORK_MODE:-}" == wrong ]] && echo '{"unexpected":{}}' || { [[ -e "$NETWORK_FENCED" ]] && echo '{}' || echo '{"krabs_default":{"EndpointID":"endpoint","Gateway":"172.20.0.1","IPAddress":"172.20.0.2","NetworkID":"network"}}'; }; } || { [[ -e "$STOPPED" ]] && echo 'false ${deployTarget}' || echo 'true ${deployTarget}'; }; exit 0 ;;
  health) exit "\${DEPLOY_HEALTH_EXIT:-0}" ;;
esac`,
    );
    const statePath = join(fixture.stateDir, "state.json");
    expect(run(fixture, "begin", deployTarget).status).toBe(0);
    writeFileSync(
      join(config, "deploy-meta.json"),
      JSON.stringify({ deployVersion: 0, resumeCutoffAware: true, apiId: "id-krabs-api" }),
    );
    const state = JSON.parse(readFileSync(statePath, "utf8")),
      runtimeEnv = join(config, "deploy-runtime-env-test"),
      compose = join(config, "compose.yml");
    writeFileSync(runtimeEnv, "KRABS_API_KEY=rotated\n");
    writeFileSync(
      compose,
      `services:\n  api:\n    env_file: ${runtimeEnv}\n  runtime:\n    env_file: ${runtimeEnv}\n  manager:\n    env_file: ${runtimeEnv}\n`,
    );
    const runtimeEnvSha = spawnSync("sha256sum", [runtimeEnv], { encoding: "utf8" }).stdout.split(
        " ",
      )[0],
      env = {
        ...fixture.env,
        KRABS_DEPLOY_TEST_MODE: "1",
        KRABS_DEPLOY_CONFIG_DIR: config,
        KRABS_DEPLOY_GUARD: guard,
        KRABS_DEPLOY_LOCK_PATH: join(fixture.dir, "deploy-controller.lock"),
        KRABS_DEPLOY_FLOCK: fixture.env.KRABS_ROLLBACK_FLOCK,
        KRABS_DEPLOY_TIMEOUT: "timeout",
        KRABS_DEPLOY_ADAPTER: adapter,
        KRABS_ROLLBACK_STATE_PATH: statePath,
        KRABS_RUNTIME_ENV_PATH: runtimeEnv,
        KRABS_RUNTIME_ENV_SHA256: runtimeEnvSha,
        KRABS_DEPLOY_LOCAL_ENV_PATH: runtimeEnv,
        KRABS_DEPLOY_COMPOSE: compose,
        KRABS_DEPLOY_HEALTH_SECONDS: "1",
        KRABS_DEPLOY_HEALTH_INTERVAL_SECONDS: "0",
        KRABS_DEPLOY_TEST_REMOTE_ROOT: remoteRoot,
        CALLS: fixture.calls,
        API_AVAILABLE: fixture.available,
        REMOTE_BIN: remoteBin,
        DEPLOY_HEALTH_EXIT: "1",
      };
    executable(join(remoteBin, "chown"), "exit 0");
    executable(
      join(remoteBin, "stat"),
      `[[ "$1" == -c ]] && { [[ "$2" == '%U %G %a' ]] && printf '%s\\n' "\${REMOTE_STAT_TEXT:-root root 600}" || printf '%s\\n' "\${REMOTE_STAT:-0 0 600}"; exit 0; }; exec /usr/bin/stat "$@"`,
    );
    const ssh = join(fixture.dir, "ssh");
    executable(
      ssh,
      `echo "ssh $*" >> "$CALLS"\n[[ "\${@: -1}" == *"exec /usr/bin/timeout"* ]] && exit 0\nPATH="$REMOTE_BIN:$PATH" bash -c "\${@: -1}"`,
    );
    const stageBefore = readFileSync(fixture.calls, "utf8").length,
      staged = spawnSync(deploy, ["--test-local-release"], {
        cwd: root,
        env: { ...env, KRABS_DEPLOY_SSH: ssh, KRABS_DEPLOY_LOCAL_ENV_PATH: runtimeEnv },
        encoding: "utf8",
        timeout: 20_000,
      }),
      stageCalls = readFileSync(fixture.calls, "utf8").slice(stageBefore);
    expect(staged.status, `${staged.stdout}${staged.stderr}\n${stageCalls}`).toBe(0);
    expect(stageCalls.indexOf("ssh ")).toBeLessThan(stageCalls.indexOf("build "));
    expect(stageCalls).toContain("chown root:root");
    expect(stageCalls).toContain("chmod 600");
    expect(stageCalls).toContain('sha256sum "$temp"');
    expect(stageCalls).toContain(`= '${runtimeEnvSha}'`);
    const stagedRuntimeEnv = join(
      remoteRoot,
      "config",
      `deploy-runtime-env-${deployTarget}-${runtimeEnvSha}`,
    );
    expect(readFileSync(stagedRuntimeEnv, "utf8")).toBe("KRABS_API_KEY=rotated\n");
    expect(existsSync(`${stagedRuntimeEnv}.tmp`)).toBe(false);
    const remoteRecovery = join(remoteRoot, "config", "deploy-recovery.json");
    const remoteMarker = join(remoteRoot, "config", "deploy-in-progress.json");
    writeFileSync(
      remoteRecovery,
      JSON.stringify({
        targetSha: deployTarget,
        runtimeEnvPath: stagedRuntimeEnv,
        runtimeEnvSha256: runtimeEnvSha,
      }),
    );
    writeFileSync(runtimeEnv, "KRABS_API_KEY=local-mismatch\n");
    writeFileSync(remoteMarker, "outer-marker-before\n");
    const mismatchRecovery = readFileSync(remoteRecovery, "utf8"),
      mismatchMarker = readFileSync(remoteMarker, "utf8"),
      mismatchBound = readFileSync(stagedRuntimeEnv, "utf8");
    const mismatchBefore = readFileSync(fixture.calls, "utf8").length;
    const mismatch = spawnSync(deploy, ["--test-local-release"], {
      cwd: root,
      env: { ...env, KRABS_DEPLOY_SSH: ssh },
      encoding: "utf8",
      timeout: 20_000,
    });
    const mismatchCalls = readFileSync(fixture.calls, "utf8").slice(mismatchBefore);
    expect(mismatch.status).not.toBe(0);
    expect(mismatchCalls).not.toContain("build ");
    expect(mismatchCalls).not.toContain("push ");
    expect(mismatchCalls).not.toContain("deploy-controller-");
    expect(mismatchCalls).not.toContain("deploy-cutover");
    expect(readFileSync(stagedRuntimeEnv, "utf8")).toBe(mismatchBound);
    expect(readFileSync(remoteRecovery, "utf8")).toBe(mismatchRecovery);
    expect(readFileSync(remoteMarker, "utf8")).toBe(mismatchMarker);
    reached.add("outer-preflight");
    reached.add("env-mismatch");
    writeFileSync(runtimeEnv, "KRABS_API_KEY=rotated\n");
    expect(
      spawnSync(deploy, ["--test-local-release"], {
        cwd: root,
        env: { ...env, KRABS_DEPLOY_SSH: ssh },
        encoding: "utf8",
        timeout: 20_000,
      }).status,
    ).toBe(0);
    rmSync(remoteRecovery);
    rmSync(remoteMarker);
    const renderedCompose = join(remoteRoot, `docker-compose-deploy-${deployTarget}.yml`);
    expect(
      readFileSync(renderedCompose, "utf8").match(new RegExp(stagedRuntimeEnv, "g")),
    ).toHaveLength(3);
    for (const row of [
      { name: "owner", content: "KRABS_API_KEY=rotated\n", stat: "1 0 600" },
      { name: "mode", content: "KRABS_API_KEY=rotated\n", stat: "0 0 644" },
      { name: "hash", content: "KRABS_API_KEY=wrong\n", stat: "0 0 600" },
    ]) {
      writeFileSync(stagedRuntimeEnv, row.content);
      writeFileSync(join(remoteRoot, "config", "deploy-recovery.json"), "{}");
      writeFileSync(remoteMarker, "outer-marker-before\n");
      const recoveryBefore = readFileSync(remoteRecovery, "utf8"),
        markerBefore = readFileSync(remoteMarker, "utf8"),
        boundBefore = readFileSync(stagedRuntimeEnv, "utf8");
      const before = readFileSync(fixture.calls, "utf8").length,
        bound = spawnSync(deploy, ["--test-local-release"], {
          cwd: root,
          env: { ...env, KRABS_DEPLOY_SSH: ssh, REMOTE_STAT: row.stat },
          encoding: "utf8",
          timeout: 20_000,
        });
      expect(bound.status, row.name).not.toBe(0);
      expect(readFileSync(stagedRuntimeEnv, "utf8"), row.name).toBe(boundBefore);
      expect(readFileSync(remoteRecovery, "utf8"), row.name).toBe(recoveryBefore);
      expect(readFileSync(remoteMarker, "utf8"), row.name).toBe(markerBefore);
      expect(existsSync(`${stagedRuntimeEnv}.tmp`), row.name).toBe(false);
      expect(readFileSync(fixture.calls, "utf8").slice(before), row.name).not.toContain("build ");
      rmSync(join(remoteRoot, "config", "deploy-recovery.json"));
      rmSync(remoteMarker);
      const retry = spawnSync(deploy, ["--test-local-release"], {
        cwd: root,
        env: { ...env, KRABS_DEPLOY_SSH: ssh },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(retry.status, row.name).toBe(0);
      expect(readFileSync(stagedRuntimeEnv, "utf8"), row.name).toBe("KRABS_API_KEY=rotated\n");
      expect(existsSync(`${stagedRuntimeEnv}.tmp`), row.name).toBe(false);
    }
    expect(readFileSync(compose, "utf8").match(new RegExp(runtimeEnv, "g"))).toHaveLength(3);
    const killAndRecover = (point: string, retryDisconnect: boolean) => {
      const barriers = join(fixture.dir, `barriers-${point}`),
        metadata = join(config, "deploy-meta.json"),
        seed = JSON.stringify({ deployVersion: 0, resumeCutoffAware: true, apiId: "id-krabs-api" });
      mkdirSync(barriers);
      rmSync(fixture.env.NETWORK_FENCED, { force: true });
      writeFileSync(metadata, seed);
      const killed = spawnSync(
        "/bin/bash",
        [
          "-c",
          '"$@" & child=$!; wait "$child"; code=$?; exit "$code"',
          "bash",
          deploy,
          "--deadline",
          "rollback",
          state.rollbackStateId,
        ],
        {
          env: {
            ...env,
            DEPLOY_DIGEST: `sha256:${digest}`,
            DEPLOY_HEALTH_EXIT: "0",
            KRABS_DEPLOY_TEST_BARRIER_DIR: barriers,
            KRABS_DEPLOY_TEST_HARD_DEATH: point,
          },
          stdio: "ignore",
          timeout: 20_000,
        },
      );
      expect(killed.status, `${point} signal=${killed.signal} error=${killed.error?.message}`).toBe(
        137,
      );
      expect(existsSync(join(config, "deploy-recovery.json")), point).toBe(true);
      expect(existsSync(join(config, "deploy-in-progress.json")), point).toBe(true);
      expect(readFileSync(metadata, "utf8"), point).toBe(seed);
      const before = readFileSync(fixture.calls, "utf8").length,
        retried = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], {
          cwd: root,
          env: { ...env, DEPLOY_DIGEST: `sha256:${digest}`, DEPLOY_HEALTH_EXIT: "0" },
          encoding: "utf8",
          timeout: 20_000,
        }),
        calls = readFileSync(fixture.calls, "utf8").slice(before);
      expect(retried.status, `${retried.stderr}\n${calls}`).toBe(0);
      expect(calls.includes("network disconnect"), point).toBe(retryDisconnect);
      expect(retried.stdout, point).toContain("DEPLOY_RECEIPT");
      expect(existsSync(join(config, "deploy-recovery.json")), point).toBe(false);
      expect(existsSync(join(config, "deploy-in-progress.json")), point).toBe(false);
      expect(readFileSync(fixture.api, "utf8").trim(), point).toBe("true");
    };
    killAndRecover("after-network-save-before-disconnect", true);
    killAndRecover("after-disconnect-before-fenced-phase", false);
    rmSync(join(config, "deploy-meta.json"));
    const rejected = (
      name: string,
      extra: Record<string, string>,
      existingMetadata = false,
      existingMarker = false,
    ) => {
      const before = readFileSync(fixture.calls, "utf8").length;
      const result = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], {
        cwd: root,
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 20_000,
      });
      const calls = readFileSync(fixture.calls, "utf8").slice(before);
      expect(result.status, name).not.toBe(0);
      expect(calls, name).not.toContain("compose --env-file");
      expect(calls, name).not.toContain(" start ");
      expect(calls, name).not.toContain("network disconnect");
      expect(existsSync(join(config, "deploy-meta.json")), name).toBe(existingMetadata);
      expect(existsSync(join(config, "deploy-in-progress.json")), name).toBe(existingMarker);
      return calls;
    };
    rejected("corrupt bound runtime environment has no cutover", {
      KRABS_RUNTIME_ENV_SHA256: "0".repeat(64),
      DEPLOY_DIGEST: `sha256:${digest}`,
    });
    writeFileSync(join(config, "deploy-meta.json"), "not-json");
    rejected("corrupt metadata has no cutover", { DEPLOY_DIGEST: `sha256:${digest}` }, true);
    rmSync(join(config, "deploy-meta.json"));
    for (const [name, metadata] of [
      ["missing deploy version", JSON.stringify({ sha: deployTarget })],
      ["malformed deploy version", JSON.stringify({ deployVersion: "1" })],
    ] as const) {
      writeFileSync(join(config, "deploy-meta.json"), metadata);
      rejected(name, { DEPLOY_DIGEST: `sha256:${digest}` }, true);
      rmSync(join(config, "deploy-meta.json"));
    }
    writeFileSync(
      join(config, "deploy-meta.json"),
      JSON.stringify({ deployVersion: 0, resumeCutoffAware: true, apiId: "id-krabs-api" }),
    );
    rejected(
      "multiple old runtime networks have no cutover",
      {
        NETWORK_MODE: "multi",
        DEPLOY_DIGEST: `sha256:${digest}`,
      },
      true,
      true,
    );
    expect(JSON.parse(readFileSync(join(config, "deploy-recovery.json"), "utf8")).phase).toBe(
      "baseline_captured",
    );
    rmSync(join(config, "deploy-recovery.json"));
    rmSync(join(config, "deploy-in-progress.json"));
    rmSync(join(config, "deploy-meta.json"));
    // prettier-ignore
    const legacyCalls = rejected("paused marker-unaware baseline has no mutation", { DEPLOY_DIGEST: `sha256:${digest}` });
    expect(existsSync(join(config, "deploy-recovery.json"))).toBe(false);
    // prettier-ignore
    expect(legacyCalls).not.toMatch(/(?:network (?:connect|disconnect)|compose .* (?:stop|create|up)| (?:stop|start) )/);
    expect(readFileSync(stagedRuntimeEnv, "utf8")).toBe("KRABS_API_KEY=rotated\n");
    // prettier-ignore
    expect(sql(fixture.control, "SELECT current_run_id || '|' || current_instance_id FROM runtime_control_state WHERE id=1")).toBe("run-before|instance-before");
    sql(fixture.control, "UPDATE runtime_control_state SET paused=0 WHERE id=1");
    writeFileSync(fixture.api, "false\n");
    rmSync(fixture.env.NETWORK_FENCED, { force: true });
    // prettier-ignore
    const cases = [{ name: "unvalidated digest has no remote mutation", digest: "invalid", recovery: false }, { name: "health exhaustion is fail-stopped", digest: `sha256:${digest}`, recovery: true }] as const;
    let failed: ReturnType<typeof spawnSync> | undefined;
    for (const row of cases) {
      const before = readFileSync(fixture.calls, "utf8");
      // prettier-ignore
      const result = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], { cwd: root, env: { ...env, DEPLOY_DIGEST: row.digest }, encoding: "utf8", timeout: 20_000 });
      expect(result.status, row.name).not.toBe(0);
      const calls = readFileSync(fixture.calls, "utf8").slice(before.length);
      if (!row.recovery) {
        expect(existsSync(join(config, "deploy-recovery.json")), row.name).toBe(false);
        expect(calls, row.name).not.toContain("compose --env-file");
      } else {
        failed = result;
      }
    }
    if (!failed) throw new Error("health exhaustion row did not run");
    expect(existsSync(join(config, "deploy-recovery.json")), String(failed.stderr)).toBe(true);
    expect(failed.status).not.toBe(0);
    const recovery = readFileSync(join(config, "deploy-recovery.json"), "utf8");
    expect(recovery).toContain("target_started");
    expect(readFileSync(fixture.api, "utf8").trim()).toBe("false");
    expect(readFileSync(fixture.calls, "utf8")).toContain("update --restart=no");
    expect(readFileSync(fixture.calls, "utf8")).toContain("stop id-krabs-runtime-manager");
    expect(readFileSync(fixture.calls, "utf8")).toContain("stop id-krabs-runtime");
    expect(readFileSync(fixture.calls, "utf8")).toMatch(
      /compose .* stop krabs-api krabs-runtime-manager krabs-runtime[\s\S]*sqlite .*deploy:.*:pause/,
    );
    expect(existsSync(join(config, "deploy-meta.json"))).toBe(false);
    expect(existsSync(join(config, "deploy-in-progress.json"))).toBe(true);
    expect(readFileSync(fixture.calls, "utf8")).toContain("ps --all -q krabs-runtime");
    const stopped = JSON.parse(recovery);
    // prettier-ignore
    Object.assign(stopped, { phase: "target_stopped_rearbitrate", targetRuntimeId: "target-runtime", targetManagerId: "target-manager", targetNetworkIds: ["krabs_default"], receipt: "" });
    writeFileSync(join(config, "deploy-recovery.json"), JSON.stringify(stopped));
    const recoveryPath = join(config, "deploy-recovery.json"),
      markerPath = join(config, "deploy-in-progress.json"),
      recoverySeed = readFileSync(recoveryPath, "utf8"),
      markerSeed = readFileSync(markerPath, "utf8"),
      boundSeed = readFileSync(stagedRuntimeEnv, "utf8");
    for (const mode of ["wrong", "multi", "zero-after-connect"]) {
      writeFileSync(recoveryPath, recoverySeed);
      writeFileSync(markerPath, markerSeed);
      if (mode === "zero-after-connect") writeFileSync(fixture.env.NETWORK_FENCED, "fenced\n");
      const before = readFileSync(fixture.calls, "utf8").length;
      const negative = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], {
        cwd: root,
        env: {
          ...env,
          DEPLOY_DIGEST: `sha256:${digest}`,
          DEPLOY_HEALTH_EXIT: "0",
          NETWORK_MODE: mode,
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      const calls = readFileSync(fixture.calls, "utf8").slice(before);
      expect(negative.status, mode).not.toBe(0);
      expect(calls, mode).not.toContain("start target-runtime");
      expect(calls, mode).not.toContain("start target-manager");
      expect(negative.stdout, mode).not.toContain("DEPLOY_RECEIPT");
      expect(existsSync(join(config, "deploy-meta.json")), mode).toBe(false);
      expect(readFileSync(recoveryPath, "utf8"), mode).toBe(recoverySeed);
      expect(readFileSync(markerPath, "utf8"), mode).toBe(markerSeed);
      expect(readFileSync(stagedRuntimeEnv, "utf8"), mode).toBe(boundSeed);
    }
    reached.add("negatives");
    writeFileSync(recoveryPath, recoverySeed);
    writeFileSync(markerPath, markerSeed);
    writeFileSync(fixture.env.NETWORK_FENCED, "fenced\n");
    const beforeRetry = readFileSync(fixture.calls, "utf8").length;
    // prettier-ignore
    const retry = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], { cwd: root, env: { ...env, DEPLOY_DIGEST: `sha256:${digest}`, DEPLOY_HEALTH_EXIT: "0" }, encoding: "utf8", timeout: 20_000 });
    expect(retry.status, retry.stderr).toBe(0);
    const reentryCalls = readFileSync(fixture.calls, "utf8").slice(beforeRetry);
    expect(reentryCalls).not.toContain("pull");
    expect(reentryCalls).not.toContain(
      " compose --env-file .env.production -f docker-compose.yml up",
    );
    expect(reentryCalls).toContain("network connect krabs_default target-runtime");
    expect(reentryCalls).toContain("actions/resume");
    expect(reentryCalls.indexOf("actions/resume")).toBeLessThan(
      reentryCalls.indexOf("start target-runtime"),
    );
    expect(
      rows(fixture).filter((row: { initiator: string }) => row.initiator.includes("resume")),
    ).toHaveLength(1);
    expect(reentryCalls).toContain("start target-runtime");
    expect(reentryCalls).toContain("start target-manager");
    expect(reentryCalls.indexOf("network connect krabs_default target-runtime")).toBeLessThan(
      reentryCalls.indexOf("start target-runtime"),
    );
    expect(JSON.parse(readFileSync(join(config, "deploy-meta.json"), "utf8")).deployVersion).toBe(
      1,
    );
    expect(retry.stdout).toContain("DEPLOY_RECEIPT");
    expect(existsSync(join(config, "deploy-recovery.json"))).toBe(false);
    expect(existsSync(join(config, "deploy-in-progress.json"))).toBe(false);
    reached.add("zero-connect");
    rmSync(join(config, "deploy-meta.json"));
    writeFileSync(recoveryPath, recoverySeed);
    writeFileSync(markerPath, markerSeed);
    rmSync(fixture.env.NETWORK_FENCED, { force: true });
    writeFileSync(fixture.env.STOPPED, "stopped\n");
    const beforeAttached = readFileSync(fixture.calls, "utf8").length;
    const attached = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], {
      cwd: root,
      env: { ...env, DEPLOY_DIGEST: `sha256:${digest}`, DEPLOY_HEALTH_EXIT: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    const attachedCalls = readFileSync(fixture.calls, "utf8").slice(beforeAttached);
    expect(attached.status, attached.stderr).toBe(0);
    expect(attachedCalls).not.toContain("network connect krabs_default target-runtime");
    expect(attachedCalls).toContain("start target-runtime");
    expect(attachedCalls).toContain("start target-manager");
    expect(attached.stdout).toContain("DEPLOY_RECEIPT");
    reached.add("attached-exact");
    const metadataPath = join(config, "deploy-meta.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    writeFileSync(
      join(config, "deploy-recovery.json"),
      JSON.stringify({
        ...stopped,
        phase: "committed_unacknowledged",
        receipt: JSON.stringify(metadata.receipt),
      }),
    );
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, runtimeEnvSha256: "0".repeat(64) }));
    expect(
      spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], {
        cwd: root,
        env,
        encoding: "utf8",
      }).status,
    ).not.toBe(0);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(
      spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], {
        cwd: root,
        env,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(spawnSync(deploy, [], { cwd: root, env, encoding: "utf8" }).status).not.toBe(0);
    expect(
      spawnSync(deploy, ["--gate-evidence", "x", "extra"], { cwd: root, env, encoding: "utf8" })
        .status,
    ).not.toBe(0);
    expect(metadata.resumeCutoffAware).toBe(true);
    reached.add("legacy-guard");
    expect([...reached].sort()).toEqual([
      "attached-exact",
      "env-mismatch",
      "legacy-guard",
      "negatives",
      "outer-preflight",
      "zero-connect",
    ]);
    console.log(
      "T28F_V24 legacy-guard outer-preflight env-mismatch zero-connect attached-exact negatives",
    );
  };
  it("T28i — selective rollback Git-object boundary", () => {
    const deploySource = readFileSync(deploy, "utf8");
    expect(deploySource).not.toContain("{{.Username}}");
    expect(deploySource).toContain('d.auths?.["ghcr.io"]');
    const repo = mkdtempSync(join(tmpdir(), "krabs-rollback-boundary-"));
    dirs.push(repo);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    // prettier-ignore
    { git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test"); git("config", "commit.gpgsign", "false"); writeFileSync(join(repo, "app.txt"), "base\n"); writeFileSync(join(repo, "deploy.sh"), "base deploy\n"); git("add", "."); git("commit", "-qm", "base"); }
    const base = git("rev-parse", "HEAD");
    const gateHash = () =>
      spawnSync(deploy, ["--print-gate-input-hash"], { cwd: repo, encoding: "utf8" });
    git("branch", "-M", "master");
    git("update-ref", "refs/remotes/origin/master", base);
    const gateEvidence = () => {
      const dir = join(repo, "gate-evidence");
      // prettier-ignore
      const names=["baseline-test.log","baseline-lint.log","gate-cases.txt","typecheck.log","build.log","post-test.log","post-lint.log","prettier.log","gate-summary.json","test-census.json",...Array.from({length:13},(_,n)=>`focused-${n}.log`)];
      const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      const counts = (passed: number) => ({ passed, failed: 0, skipped: 0, total: passed });
      // prettier-ignore
      const deltas={"@krabs/runtime":[2,36],"@krabs/exchange":[0,1],"@krabs/scripts":[1,7],"@krabs/db":[0,1],"@krabs/api":[0,1]} as const;
      const packageDeltas = { ...deltas, "@krabs/config": [0, 0] } as const;
      mkdirSync(dir);
      writeFileSync(join(repo, ".git", "info", "exclude"), "gate-evidence/\n");
      for (const name of names)
        writeFileSync(
          join(dir, name),
          name.startsWith("focused-") ? "Test Files  1 passed (1)\nTests  1 passed (1)\n" : "ok\n",
        );
      const testLog = (delta = 0) =>
        Object.entries(packageDeltas)
          .flatMap(([name, [files, tests]]) => [
            `${name}:test: Test Files  ${10 + delta * files} passed (${10 + delta * files})`,
            `${name}:test: Tests  ${100 + delta * tests} passed (${100 + delta * tests})`,
          ])
          .join("\n") + "\n";
      const lintLog =
        "@krabs/runtime:lint: 33 problems (0 errors, 33 warnings)\n@krabs/scripts:lint: 116 problems (0 errors, 116 warnings)\n";
      const postLintLog = lintLog.replaceAll("116", "117");
      writeFileSync(join(dir, "baseline-test.log"), testLog());
      writeFileSync(join(dir, "post-test.log"), `Tasks: 15 successful, 15 total\n${testLog(1)}`);
      writeFileSync(join(dir, "baseline-lint.log"), lintLog);
      writeFileSync(join(dir, "post-lint.log"), postLintLog);
      writeFileSync(join(dir, "typecheck.log"), "Tasks: 15 successful, 15 total\n");
      writeFileSync(join(dir, "build.log"), "Tasks: 9 successful, 9 total\n");
      writeFileSync(join(dir, "prettier.log"), "All matched files use Prettier code style!\n");
      // prettier-ignore
      writeFileSync(join(dir,"gate-cases.txt"),"T1 T2 T3 T4 T5 T6 T7 T8 T9 T10a T10b T11 T12 T13 T13b T13d T14 T14b T15 T16 T17 T18a T18b-core T18b-log T18c T19 T20 T21a T21b T21c T22 T23 T24 T25 T26 T27 T28a T28b T28c T28d T28e T28f T28g T28h T28i".split(" ").map(tag=>`${tag} — ok`).join("\n"));
      const input = gateHash();
      if (input.status !== 0) throw new Error(input.stderr);
      const head = git("rev-parse", "HEAD");
      // prettier-ignore
      const steps=["focused","allowlist","bash","typecheck","build","test","census","lint","prettier"];
      writeFileSync(
        join(dir, "gate-summary.json"),
        JSON.stringify({
          schemaVersion: 1,
          status: "passed",
          gateCompletedAtEpoch: 0,
          repoInputHash: input.stdout.trim(),
          requiredSteps: steps,
        }),
      );
      writeFileSync(
        join(dir, "test-census.json"),
        JSON.stringify({
          baseline: Object.fromEntries(
            Object.keys(packageDeltas).map((key) => [
              key,
              { files: counts(10), tests: counts(100) },
            ]),
          ),
          post: Object.fromEntries(
            Object.entries(packageDeltas).map(([key, [files, tests]]) => [
              key,
              { files: counts(10 + files), tests: counts(100 + tests) },
            ]),
          ),
        }),
      );
      const evidence = join(dir, "manifest.json");
      const manifest = () =>
        writeFileSync(
          evidence,
          JSON.stringify({
            schemaVersion: 1,
            status: "passed",
            gateCompletedAtEpoch: 0,
            branch: "master",
            headSha: head,
            originSha: head,
            repoInputHash: input.stdout.trim(),
            nodeVersion: process.version,
            pnpmVersion: spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout.trim(),
            requiredSteps: steps,
            logs: names.map((name) => ({ path: join(dir, name), sha256: hash(join(dir, name)) })),
          }),
        );
      manifest();
      const valid = spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(valid.status, valid.stderr).toBe(0);
      writeFileSync(join(dir, "baseline-test.log"), testLog().replace("100 passed", "101 passed"));
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "baseline-test.log"), testLog());
      writeFileSync(
        join(dir, "post-lint.log"),
        postLintLog.replace("117 warnings", "118 warnings"),
      );
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "post-lint.log"), postLintLog);
      writeFileSync(join(dir, "gate-cases.txt"), "T1 — changed\n");
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
    };
    gateEvidence();
    // A tracked gitlink is a directory in the worktree, while a symlink must not be followed.
    mkdirSync(join(repo, ".claude", "worktrees", "outcome-mapping-fix"), { recursive: true });
    git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"a".repeat(40)},.claude/worktrees/outcome-mapping-fix`,
    );
    symlinkSync("/outside-the-repository", join(repo, "external-link"));
    const firstGateHash = gateHash();
    expect(firstGateHash.status, firstGateHash.stderr).toBe(0);
    expect(firstGateHash.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"b".repeat(40)},.claude/worktrees/outcome-mapping-fix`,
    );
    const changedGitlinkHash = gateHash();
    expect(changedGitlinkHash.status, changedGitlinkHash.stderr).toBe(0);
    expect(changedGitlinkHash.stdout.trim()).not.toBe(firstGateHash.stdout.trim());
    rmSync(join(repo, "external-link"));
    rmSync(join(repo, ".claude"), { recursive: true });
    git("update-index", "--force-remove", ".claude/worktrees/outcome-mapping-fix");
    // prettier-ignore
    { writeFileSync(join(repo, "app.txt"), "release\n"); writeFileSync(join(repo, "deploy.sh"), "release deploy\n"); writeFileSync(join(repo, "added.txt"), "release-only\n"); git("add", "."); git("commit", "-qm", "release"); }
    const release = git("rev-parse", "HEAD");
    // prettier-ignore
    { writeFileSync(join(repo, "app.txt"), "base\n"); writeFileSync(join(repo, "added.txt"), "release-only\n"); git("add", "."); git("commit", "-qm", "bad full rollback"); }
    // prettier-ignore
    const bad = spawnSync(deploy, ["--verify-rollback-boundary", base, release], { cwd: repo, encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    // prettier-ignore
    { writeFileSync(join(repo, "added.txt"), ""); rmSync(join(repo, "added.txt")); git("add", "-A"); git("commit", "-qm", "remove release-only path"); }
    // prettier-ignore
    const good = spawnSync(deploy, ["--verify-rollback-boundary", base, release], { cwd: repo, encoding: "utf8" });
    if (good.status !== 0) throw new Error(good.stderr);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("ROLLBACK_BOUNDARY_OK");
  }, 30_000);
});
