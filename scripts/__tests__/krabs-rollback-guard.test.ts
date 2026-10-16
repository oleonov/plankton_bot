import { afterEach, beforeEach, describe, expect, it } from "vitest";
// prettier-ignore
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
// One guard/deploy script call spawns dozens of stub processes and took over 10s under heavy load
// (load average ~20). The ceiling only exists to catch a hung guard, so it can be generous.
const SCRIPT_CALL_TIMEOUT_MS = 30_000;
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
  const stateDir=join(dir,"state"), marker=join(dir,"rollback.json"), control=join(dir,"control.db"), data=join(dir,"data"), ledger=join(data,"ledger-live-lite.db"), api=join(dir,"api-state"), available=join(dir,"api-available"), identity=join(dir,"identity"), health=join(dir,"health-identity"), calls=join(dir,"calls"), arbitrationPolls=join(dir,"arbitration-polls"), sqlite=join(dir,"sqlite"), curl=join(dir,"curl"), docker=join(dir,"docker"), flock=join(dir,"flock"), systemctl=join(dir,"systemctl"), installBin=join(dir,"install","guard"), units=join(dir,"units"), fenced=join(dir,"network-fenced");
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
    `echo "sqlite $*" >> "$CALLS"\n[[ "\${CUTOFF_WRITER:-}" == 1 && "\${2:-}" == *"BEGIN IMMEDIATE; SELECT coalesce(max(id),0) FROM operator_commands; COMMIT;"* ]] && /usr/bin/sqlite3 "$1" "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:00.000Z');"\n[[ "\${ARBITRATION_PAUSE:-}" == 1 && "\${2:-}" == *"SELECT action || '|' || status"* && "$(/usr/bin/sqlite3 "$1" "SELECT count(*) FROM operator_commands WHERE initiator LIKE 'rollback:%:resume';")" == 1 ]] && { /usr/bin/sqlite3 "$1" "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:01.000Z');"; echo true > "$API_STATE"; }\n/usr/bin/sqlite3 "$@"\nif [[ "\${DEPLOY_ARBITRATION_LATE_PAUSE:-}" == 1 && "\${2:-}" == *"SELECT status FROM operator_commands WHERE initiator='deploy:"* && ! -e "$ARBITRATION_POLL_COUNTER.late" ]]; then /usr/bin/sqlite3 "$1" "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2026-01-01T00:00:02.000Z');"; echo true > "$API_STATE"; : > "$ARBITRATION_POLL_COUNTER.late"; fi\nif [[ -n "\${ARBITRATION_APPLY_AFTER_POLLS:-}" && "\${2:-}" == *"SELECT status FROM operator_commands WHERE initiator="* ]]; then polls=0; [[ ! -f "$ARBITRATION_POLL_COUNTER" ]] || polls=$(cat "$ARBITRATION_POLL_COUNTER"); polls=$((polls+1)); printf '%s\n' "$polls" > "$ARBITRATION_POLL_COUNTER"; if (( polls >= ARBITRATION_APPLY_AFTER_POLLS )); then action=$(/usr/bin/sqlite3 "$1" "SELECT action FROM operator_commands WHERE status='pending' ORDER BY id DESC LIMIT 1;"); /usr/bin/sqlite3 "$1" "UPDATE operator_commands SET status='applied' WHERE status='pending';"; [[ "$action" == pause ]] && echo true > "$API_STATE"; [[ "$action" == resume ]] && echo false > "$API_STATE"; fi; fi\nif [[ "\${2:-}" == *"INSERT INTO operator_commands"* && -z "\${ARBITRATION_APPLY_AFTER_POLLS:-}" ]]; then action=$(/usr/bin/sqlite3 "$1" "SELECT action FROM operator_commands WHERE status='pending' ORDER BY id DESC LIMIT 1;"); /usr/bin/sqlite3 "$1" "UPDATE operator_commands SET status='applied' WHERE status='pending';"; [[ "$action" == pause ]] && echo true > "$API_STATE"; [[ "$action" == resume ]] && echo false > "$API_STATE"; fi\ntrue`,
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
  const env = { ...process.env, KRABS_ROLLBACK_TEST_MODE: "1", KRABS_ROLLBACK_STATE_DIR: stateDir, KRABS_ROLLBACK_MARKER_PATH: marker, KRABS_ROLLBACK_CONTROL_DB_PATH: control, KRABS_ROLLBACK_DATA_DIR: data, KRABS_ROLLBACK_SQLITE: sqlite, KRABS_ROLLBACK_CURL: curl, KRABS_ROLLBACK_DOCKER: docker, KRABS_ROLLBACK_FLOCK: flock, KRABS_ROLLBACK_SYSTEMCTL: systemctl, KRABS_ROLLBACK_INSTALL_BIN: installBin, KRABS_ROLLBACK_UNIT_DIR: units, KRABS_ROLLBACK_TIMEOUT_BIN: "timeout", KRABS_ROLLBACK_POLL_ATTEMPTS: "2", KRABS_ROLLBACK_POLL_INTERVAL_SECONDS: "0", KRABS_DEPLOY_LOCK_PATH: join(dir, "deploy.lock"), CALLS: calls, API_STATE: api, API_AVAILABLE: available, IDENTITY: identity, HEALTH_IDENTITY: health, NETWORK_FENCED: fenced, STOPPED: join(dir, "stopped"), ARBITRATION_POLL_COUNTER: arbitrationPolls };
  // prettier-ignore
  return { dir, stateDir, marker, control, data, ledger, api, available, identity, health, calls, installBin, units, env };
}
// prettier-ignore
function run(fixture: Fixture,...args: string[]) { const result=spawnSync(guard,args,{env:fixture.env,encoding:"utf8",timeout:SCRIPT_CALL_TIMEOUT_MS}); if(result.error) throw new Error(`${result.error.message}\n${result.stderr}`); return result; }
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
  it("T28l — failed image build stops publication and remote staging", () => {
    const dir = mkdtempSync(join(tmpdir(), "krabs-publish-failfast-")),
      calls = join(dir, "calls"),
      adapter = join(dir, "adapter"),
      ssh = join(dir, "ssh"),
      runtimeEnv = join(dir, "runtime.env"),
      deployTarget = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      digest = "d".repeat(64);
    dirs.push(dir);
    writeFileSync(calls, "");
    writeFileSync(runtimeEnv, "SAFE=test\n");
    executable(
      adapter,
      `echo "$*" >> "$CALLS"; shift
case "$1" in
  build) if [[ "\${FAIL_BUILD:-}" == 1 ]]; then exit 17; fi ;;
  push) echo 'digest: sha256:${digest}' ;;
  image) [[ "$*" == *revision* ]] && echo '${deployTarget}' || echo 'sha256:${digest}' ;;
esac
exit 0`,
    );
    executable(
      ssh,
      `echo "ssh $*" >> "$CALLS"
[[ "\${@: -1}" == *"exec /usr/bin/timeout"* ]] && echo remote-controller >> "$CALLS"
cat >/dev/null`,
    );
    const runDeploy = (failBuild: boolean) =>
      spawnSync(deploy, ["--test-local-release"], {
        cwd: root,
        env: {
          ...process.env,
          KRABS_DEPLOY_TEST_MODE: "1",
          KRABS_DEPLOY_ADAPTER: adapter,
          KRABS_DEPLOY_SSH: ssh,
          KRABS_DEPLOY_LOCAL_ENV_PATH: runtimeEnv,
          KRABS_DEPLOY_TEST_REMOTE_ROOT: join(dir, "remote"),
          CALLS: calls,
          FAIL_BUILD: failBuild ? "1" : "0",
        },
        encoding: "utf8",
        timeout: SCRIPT_CALL_TIMEOUT_MS,
      });
    const failed = runDeploy(true),
      failedCalls = readFileSync(calls, "utf8");
    expect(failed.status, failed.stderr).not.toBe(0);
    expect(failed.stderr).toContain("image build failed");
    expect(failedCalls).toContain("docker build");
    expect(failedCalls).not.toContain("docker push");
    expect(failedCalls).not.toContain("remote-controller");
    writeFileSync(calls, "");
    const succeeded = runDeploy(false),
      succeededCalls = readFileSync(calls, "utf8");
    expect(succeeded.status, succeeded.stderr).toBe(0);
    expect(succeededCalls).toContain("docker push");
    expect(succeededCalls).toContain("remote-controller");
  });
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
  const t28dMatrix=()=>{ const cases=[{name:"status transport",env:{CURL_MODE:"transport"}},{name:"status malformed",env:{CURL_MODE:"status-malformed"}},{name:"status missing envelope",env:{CURL_MODE:"status-missing"}},{name:"status paused null",env:{CURL_MODE:"status-null"}},{name:"status paused string",env:{CURL_MODE:"status-string"}},{name:"health malformed",env:{CURL_MODE:"health-malformed"}},{name:"health mismatched",env:{CURL_MODE:"health-mismatch"}},{name:"compose nonzero",env:{DOCKER_MODE:"compose-nonzero"}},{name:"inspect nonzero",env:{DOCKER_MODE:"inspect-nonzero"}},{name:"mixed target/api original",env:{DOCKER_MODE:"mixed"}},{name:"missing container",env:{DOCKER_MODE:"missing"}},{name:"stopped container",env:{DOCKER_MODE:"stopped"}},{name:"bad revision label",env:{DOCKER_MODE:"bad-label"}}] as const; for(const paused of [false,true]) for(const row of cases) { const fixture=makeFixture(paused),result=spawnSync(guard,["begin",target],{env:{...fixture.env,...row.env},encoding:"utf8",timeout:SCRIPT_CALL_TIMEOUT_MS}); expect(result.status,`${row.name} paused=${paused}`).not.toBe(0); untouchedBegin(fixture,paused); } };
  // prettier-ignore
  const t28dState=()=>{ const fixture=makeFixture(false); expect(run(fixture,"begin",target).status).toBe(0); const prepared=readFileSync(join(fixture.stateDir,"state.json"),"utf8"); expect(run(fixture,"finalize",original).status).not.toBe(0); expect(readFileSync(join(fixture.stateDir,"state.json"),"utf8")).toBe(prepared); expect(run(fixture,"abort").status).toBe(0); expect(existsSync(join(fixture.stateDir,"state.json"))).toBe(false); expect(run(fixture,"watch").status).toBe(0); const blocked=makeFixture(false); begin(blocked); addMultirow(blocked); expect(run(blocked,"watch").status).toBe(20); const before=readFileSync(join(blocked.stateDir,"state.json"),"utf8"); expect(run(blocked,"abort").status).not.toBe(0); expect(readFileSync(join(blocked.stateDir,"state.json"),"utf8")).toBe(before); };
  // prettier-ignore
  it("T28e — kernel lock ordering and timeout release", async () => { const fixture=makeFixture(false),lock=join(fixture.stateDir,"operation.lock"); mkdirSync(fixture.stateDir); const holder=spawn("/usr/bin/perl",["-MFcntl=:flock","-e","open(my $fh, '>', $ARGV[0]) or die; flock($fh, LOCK_EX) or die; sleep 1",lock]); await new Promise(resolve=>setTimeout(resolve,100)); expect(run(fixture,"watch").status).not.toBe(0); await new Promise<void>(resolve=>holder.on("exit",()=>resolve())); expect(run(fixture,"watch").status).toBe(0); expect(readFileSync(fixture.calls,"utf8")).toContain("flock --exclusive --nonblock"); t28eTimeout(); },40_000);
  // prettier-ignore
  const t28eTimeout = () => { const fixture=makeFixture(false); begin(fixture); const before=readFileSync(join(fixture.stateDir,"state.json"),"utf8"); const timed=spawnSync(guard,["watch"],{env:{...fixture.env,DOCKER_HANG:"1",KRABS_ROLLBACK_COMMAND_TIMEOUT_SECONDS:"1"},encoding:"utf8",timeout:SCRIPT_CALL_TIMEOUT_MS}); expect(timed.status).toBe(124); expect(readFileSync(join(fixture.stateDir,"state.json"),"utf8")).toBe(before); expect(readFileSync(fixture.api,"utf8").trim()).toBe("true"); expect(run(fixture,"status").status).toBe(0); };
  // prettier-ignore
  it("T28f — controller failure, intent arbitration, and API cutover", async () => { t28fIntent(); t28fDelayedStartup(); await t28fController(false); },150_000);
  it("T28k — deploy arbitration is target-bound across a rejected legacy command", () => {
    const fixture = makeFixture(true);
    targetReady(fixture);
    sql(
      fixture.control,
      "INSERT INTO operator_commands(action,initiator_type,initiator,status,created_at) VALUES ('resume','system','deploy:state:resume','rejected','2026-09-07T07:42:48.319Z')",
    );

    const first = run(fixture, "deploy-arbitrate", "state", "false", "0", target);
    expect(first.status, first.stderr).toBe(0);
    expect(rows(fixture)).toEqual([
      {
        action: "resume",
        initiator_type: "system",
        initiator: "deploy:state:resume",
        status: "rejected",
      },
      {
        action: "resume",
        initiator_type: "system",
        initiator: `deploy:state:${target}:resume`,
        status: "applied",
      },
    ]);
    expect(run(fixture, "deploy-arbitrate", "state", "false", "0", target).status).toBe(0);
    expect(rows(fixture)).toHaveLength(2);

    const rejected = makeFixture(true);
    targetReady(rejected);
    sql(
      rejected.control,
      `INSERT INTO operator_commands(action,initiator_type,initiator,status,created_at) VALUES ('resume','system','deploy:state:${target}:resume','rejected','2026-09-07T07:42:48.319Z')`,
    );
    expect(run(rejected, "deploy-arbitrate", "state", "false", "0", target).status).not.toBe(0);
    expect(rows(rejected)).toHaveLength(1);

    const cutover = makeFixture(true);
    targetReady(cutover);
    expect(run(cutover, "deploy-cutover", "state").status).toBe(0);
    expect(run(cutover, "deploy-arbitrate", "state", "true", "0", target).status).toBe(0);
    expect(rows(cutover).map((row: { initiator: string }) => row.initiator)).toEqual([
      "deploy:state:pause",
      `deploy:state:${target}:pause`,
    ]);

    for (const args of [
      ["deploy-arbitrate", "state", "false", "0"],
      ["deploy-arbitrate", "state", "false", "0", "short"],
    ]) {
      const invalid = makeFixture(false);
      expect(run(invalid, ...args).status).not.toBe(0);
      expect(rows(invalid)).toEqual([]);
    }
    const wrongIdentity = makeFixture(false);
    expect(run(wrongIdentity, "deploy-arbitrate", "state", "false", "0", target).status).not.toBe(
      0,
    );
    expect(rows(wrongIdentity)).toEqual([]);

    const latePause = makeFixture(true);
    targetReady(latePause);
    const lateResult = spawnSync(guard, ["deploy-arbitrate", "state", "false", "0", target], {
      env: {
        ...latePause.env,
        DEPLOY_ARBITRATION_LATE_PAUSE: "1",
        KRABS_DEPLOY_ARBITRATION_POLL_ATTEMPTS: "2",
      },
      encoding: "utf8",
      timeout: SCRIPT_CALL_TIMEOUT_MS,
    });
    expect(lateResult.status).not.toBe(0);
    expect(readFileSync(latePause.api, "utf8").trim()).toBe("true");
    expect(rows(latePause)).toEqual([
      expect.objectContaining({
        action: "resume",
        initiator: `deploy:state:${target}:resume`,
        status: "applied",
      }),
      expect.objectContaining({ action: "pause", initiator_type: "operator", status: "applied" }),
    ]);
  }, 15_000);
  it("T28j — stopped recovery supersede is exact and fail-closed", async () => {
    await t28fController(true);
  }, 40_000);
  // prettier-ignore
  const t28fIntent = () => { const cases = [{ stage: "precommit", commands: [] as string[], expected: "resume" }, { stage: "commit_ready pause dominates", commands: ["pause"], expected: "pause" }, { stage: "after receipt pause then resume folds", commands: ["pause", "resume"], expected: "resume" }]; for (const row of cases) { const fixture = makeFixture(false); sql(fixture.control, "INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('pause','operator','applied','2000-01-01T00:00:00.000Z')"); for (const [index, action] of row.commands.entries()) sql(fixture.control, `INSERT INTO operator_commands(action,initiator_type,status,created_at) VALUES ('${action}','operator','applied','2026-01-01T00:00:0${index}.000Z')`); const receipt = run(fixture, "deploy-arbitrate", "state", "false", "1", original); expect(receipt.status, row.stage).toBe(0); expect(JSON.parse(receipt.stdout).finalAction, row.stage).toBe(row.expected); expect(readFileSync(fixture.api, "utf8").trim(), row.stage).toBe(String(row.expected === "pause")); } };
  const t28fDelayedStartup = () => {
    const fixture = makeFixture(true);
    const result = spawnSync(guard, ["deploy-arbitrate", "slow-startup", "false", "0", original], {
      env: { ...fixture.env, ARBITRATION_APPLY_AFTER_POLLS: "61" },
      encoding: "utf8",
      // This exercises 61 real subprocess polls, not a ten-second wall-clock contract.
      timeout: 60_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(Number(readFileSync(fixture.env.ARBITRATION_POLL_COUNTER, "utf8"))).toBeGreaterThan(60);
    expect(rows(fixture)).toEqual([
      {
        action: "resume",
        initiator_type: "system",
        initiator: `deploy:slow-startup:${original}:resume`,
        status: "applied",
      },
    ]);
    expect(readFileSync(fixture.api, "utf8").trim()).toBe("false");
  };
  const t28fController = async (supersedeOnly: boolean) => {
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
  compose) [[ "$*" == *" stop krabs-api"* ]] && { rm -f "$API_AVAILABLE"; [[ -z "\${OLD_API_REPLACED:-}" ]] || : > "$OLD_API_REPLACED"; }; [[ "$*" == *" create "* ]] && { rm -f "$NETWORK_FENCED"; printf '%s\n' '${deployTarget}' > "$IDENTITY"; printf '%s\n' '${deployTarget}' > "$HEALTH_IDENTITY"; }; [[ "$*" == *" up -d --no-deps"* ]] && : > "$API_AVAILABLE"; [[ "$*" == *" ps --all -q "* ]] && echo "id-\${@: -1}"; exit 0 ;;
  build|tag|update) exit 0 ;;
  ps) [[ "\${API_DISCOVERY_MODE:-}" == none ]] || { echo id-krabs-api; [[ "\${API_DISCOVERY_MODE:-}" == multi ]] && echo foreign-api; }; exit 0 ;;
  pull) echo 'fake pull progress'; exit 0 ;;
  stop) : > "$STOPPED"; exit 0 ;;
  start) rm -f "$STOPPED"; exit 0 ;;
  network) if [[ "$2" == disconnect && "$*" == *target-manager* ]]; then : > "$MANAGER_NETWORK_FENCED"; elif [[ "$2" == connect && "\${NETWORK_MODE:-}" != zero-after-connect ]]; then rm -f "$NETWORK_FENCED"; else : > "$NETWORK_FENCED"; fi; exit 0 ;;
  push) echo "digest: \${DEPLOY_DIGEST:-sha256:${digest}}"; exit 0 ;;
  image) [[ "$*" == *revision* ]] && echo '${deployTarget}' || echo 'sha256:${digest}'; exit 0 ;;
  inspect) if [[ "\${SUPERSEDE_TEST:-}" == 1 && "$*" == *id-krabs-api* && ! -e "$OLD_API_REPLACED" && "$*" == *NetworkSettings.Networks* ]]; then [[ "\${API_NETWORK_MODE:-}" == wrong ]] && echo '{"unexpected":{}}' || echo '{"krabs_default":{}}'; elif [[ "\${SUPERSEDE_TEST:-}" == 1 && "$*" == *id-krabs-api* && ! -e "$OLD_API_REPLACED" ]]; then echo "\${OLD_API_RUNNING:-true} \${OLD_API_SHA:-${target}} \${OLD_API_IMAGE:-sha256:${"a".repeat(64)}}"; elif [[ "\${SUPERSEDE_TEST:-}" == 1 && ( "$*" == *target-runtime* || "$*" == *target-manager* ) && "$*" == *RestartPolicy.Name* ]]; then echo "\${OLD_TARGET_RUNNING:-false} \${OLD_TARGET_RESTART:-no} \${OLD_TARGET_SHA:-${target}} \${OLD_TARGET_IMAGE:-sha256:${"a".repeat(64)}}"; elif [[ "\${SUPERSEDE_TEST:-}" == 1 && "$*" == *target-manager* && "$*" == *NetworkSettings.Networks* ]]; then [[ -e "$MANAGER_NETWORK_FENCED" ]] && echo '{}' || { [[ "\${MANAGER_NETWORK_MODE:-}" == foreign ]] && echo '{"krabs_default":{},"krabs_manager-net":{},"unexpected":{}}' || echo '{"krabs_default":{},"krabs_manager-net":{}}'; }; elif [[ "\${SUPERSEDE_TEST:-}" == 1 && ( "$*" == *target-runtime* || "$*" == *target-manager* ) && "$*" != *NetworkSettings.Networks* ]]; then echo "\${OLD_TARGET_RUNNING:-false} \${OLD_TARGET_SHA:-${target}}"; elif [[ "$*" == *NetworkSettings.Networks* ]]; then [[ "\${NETWORK_MODE:-}" == multi ]] && echo '{"krabs_default":{},"unexpected":{}}' || [[ "\${NETWORK_MODE:-}" == wrong ]] && echo '{"unexpected":{}}' || { [[ -e "$NETWORK_FENCED" ]] && echo '{}' || echo '{"krabs_default":{"EndpointID":"endpoint","Gateway":"172.20.0.1","IPAddress":"172.20.0.2","NetworkID":"network"}}'; }; elif [[ "$*" == *id-krabs-api* ]]; then [[ -e "$API_AVAILABLE" ]] && echo 'true ${deployTarget}' || echo 'false ${deployTarget}'; else [[ -e "$STOPPED" ]] && echo 'false ${deployTarget}' || echo 'true ${deployTarget}'; fi; exit 0 ;;
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
    if (supersedeOnly) {
      const metadataPath = join(config, "deploy-meta.json"),
        recoveryPath = join(config, "deploy-recovery.json"),
        markerPath = join(config, "deploy-in-progress.json"),
        oldRuntimeEnv = join(config, `deploy-runtime-env-${target}-${runtimeEnvSha}`),
        oldApiReplaced = join(fixture.dir, "old-api-replaced"),
        managerNetworkFenced = join(fixture.dir, "manager-network-fenced"),
        orderGate = join(fixture.dir, "supersede-order-status-gate"),
        orderGateCalls = join(fixture.dir, "supersede-order-status-gate-calls"),
        oldDigest = `sha256:${"a".repeat(64)}`,
        recoveryStateId = state.rollbackStateId,
        supersedeMeta = JSON.stringify({
          deployVersion: 0,
          sha: original,
          digest: `sha256:${"c".repeat(64)}`,
          resumeCutoffAware: true,
          apiId: "id-krabs-api",
          runtimeEnvSha256: runtimeEnvSha,
        }),
        supersedeMarker = JSON.stringify({
          schemaVersion: 1,
          deploymentId: recoveryStateId,
          updatedAt: "2026-08-26T00:00:00Z",
        }),
        supersedeState = {
          schemaVersion: 1,
          recoveryStateId,
          deliveryMode: "release",
          phase: "target_stopped_rearbitrate",
          targetSha: target,
          digest: oldDigest,
          imageId: oldDigest,
          prePaused: false,
          previousVersion: 0,
          baselineCapturedUnderLock: true,
          baselineCommandHighWater: state.baselineCommandHighWater,
          finalCommandHighWater: 0,
          preRunId: "run-before",
          preInstanceId: "instance-before",
          preRuntimeId: "id-krabs-runtime",
          preApiId: "id-krabs-api",
          preManagerId: "id-krabs-runtime-manager",
          controllerPid: 1,
          controllerStartTicks: "1",
          workerPgid: 1,
          tradingCutoverInvoked: true,
          targetRuntimeId: "target-runtime",
          targetManagerId: "target-manager",
          targetNetworkIds: ["krabs_default"],
          restartPolicies: { runtime: "no", manager: "no" },
          candidateHash: "",
          receipt: "",
          migrationGate: { mode: "post", stale: true },
          runtimeEnvPath: oldRuntimeEnv,
          runtimeEnvSha256: runtimeEnvSha,
        },
        supersedeEnv = {
          ...env,
          KRABS_REMOTE_CONTROLLER: "1",
          KRABS_REMOTE_SHA: deployTarget,
          KRABS_REMOTE_DIGEST: `sha256:${digest}`,
          KRABS_REMOTE_COMPOSE: compose,
          KRABS_REMOTE_ENV: runtimeEnv,
          KRABS_ORDER_STATUS_GATE: orderGate,
          ORDER_GATE_CALLS: orderGateCalls,
          DEPLOY_HEALTH_EXIT: "0",
        },
        runSupersede = (expectedOld = target, extra: Record<string, string> = {}) =>
          spawnSync(deploy, ["--internal", "supersede", expectedOld], {
            cwd: root,
            env: {
              ...supersedeEnv,
              SUPERSEDE_TEST: "1",
              OLD_TARGET_SHA: target,
              OLD_TARGET_RUNNING: "false",
              OLD_TARGET_RESTART: "no",
              OLD_TARGET_IMAGE: oldDigest,
              OLD_API_SHA: target,
              OLD_API_RUNNING: "true",
              OLD_API_IMAGE: oldDigest,
              OLD_API_REPLACED: oldApiReplaced,
              MANAGER_NETWORK_FENCED: managerNetworkFenced,
              ...extra,
            },
            encoding: "utf8",
            timeout: 25_000,
          }),
        seedSupersede = (
          recoveryPatch: Record<string, unknown> = {},
          metadata = supersedeMeta,
          marker = supersedeMarker,
        ) => {
          writeFileSync(oldRuntimeEnv, "KRABS_API_KEY=rotated\n");
          writeFileSync(recoveryPath, JSON.stringify({ ...supersedeState, ...recoveryPatch }));
          writeFileSync(metadataPath, metadata);
          writeFileSync(markerPath, marker);
          writeFileSync(fixture.env.STOPPED, "stopped\n");
          writeFileSync(fixture.available, "yes\n");
          rmSync(statePath, { force: true });
          rmSync(fixture.marker, { force: true });
          rmSync(oldApiReplaced, { force: true });
          rmSync(managerNetworkFenced, { force: true });
          rmSync(fixture.env.NETWORK_FENCED, { force: true });
        };
      writeFileSync(orderGateCalls, "");
      executable(
        orderGate,
        `echo "$1" >> "$ORDER_GATE_CALLS"
echo "order-gate $1" >> "$CALLS"
[[ "$1" == post ]] && marker=true || marker=false
printf '{"migration101":{"candidateCount":0,"candidateHash":"%s","rowsHash":"%s","markerWasPresent":%s},"migration102":{"markerWasPresent":false,"tableWasPresent":false,"rowCount":0,"rowsHash":"%s","schemaHash":"%s"},"migration103":{"markerWasPresent":false,"tableWasPresent":false,"rowCount":0,"rowsHash":"%s","schemaHash":"%s"},"migration106":{"candidateCount":0,"candidateHash":"%s","markerWasPresent":%s}}\\n' '${"a".repeat(64)}' '${"b".repeat(64)}' "$marker" '${"c".repeat(64)}' '${"d".repeat(64)}' '${"e".repeat(64)}' '${"f".repeat(64)}' '${"9".repeat(64)}' "$marker"`,
      );
      seedSupersede();
      writeFileSync(statePath, "active rollback\n");
      writeFileSync(fixture.marker, "active rollback\n");
      const recoveryBeforeRollbackConflict = readFileSync(recoveryPath, "utf8"),
        callsBeforeRollbackConflict = readFileSync(fixture.calls, "utf8").length,
        rollbackConflict = runSupersede(),
        rollbackConflictCalls = readFileSync(fixture.calls, "utf8").slice(
          callsBeforeRollbackConflict,
        );
      expect(rollbackConflict.status).not.toBe(0);
      expect(rollbackConflictCalls).not.toMatch(
        /(?:^|\n)(?:pull |network disconnect|compose .* (?:stop|create|up)|start )/,
      );
      expect(readFileSync(recoveryPath, "utf8")).toBe(recoveryBeforeRollbackConflict);
      for (const row of [
        { name: "wrong expected old SHA", expected: original },
        { name: "wrong phase", patch: { phase: "target_started" } },
        { name: "changed environment", patch: { runtimeEnvSha256: "0".repeat(64) } },
        { name: "advanced metadata", metadata: JSON.stringify({ deployVersion: 1, sha: target }) },
        {
          name: "foreign marker",
          marker: JSON.stringify({ schemaVersion: 1, deploymentId: "foreign" }),
        },
        { name: "wrong runtime identity", extra: { OLD_TARGET_SHA: original } },
        { name: "running runtime", extra: { OLD_TARGET_RUNNING: "true" } },
        { name: "restart-enabled runtime", extra: { OLD_TARGET_RESTART: "unless-stopped" } },
        { name: "wrong runtime image", extra: { OLD_TARGET_IMAGE: oldDigest.replace(/a/g, "b") } },
        { name: "stopped API", extra: { OLD_API_RUNNING: "false" } },
        { name: "wrong API identity", extra: { OLD_API_SHA: original } },
        { name: "wrong API image", extra: { OLD_API_IMAGE: oldDigest.replace(/a/g, "b") } },
        { name: "foreign API network", extra: { API_NETWORK_MODE: "wrong" } },
        { name: "ambiguous API discovery", extra: { API_DISCOVERY_MODE: "multi" } },
        { name: "foreign network", extra: { NETWORK_MODE: "wrong" } },
        { name: "multiple networks", extra: { NETWORK_MODE: "multi" } },
        { name: "foreign manager network", extra: { MANAGER_NETWORK_MODE: "foreign" } },
      ]) {
        seedSupersede(row.patch, row.metadata, row.marker);
        const recoveryBefore = readFileSync(recoveryPath, "utf8"),
          metadataBefore = readFileSync(metadataPath, "utf8"),
          markerBefore = readFileSync(markerPath, "utf8"),
          callsBefore = readFileSync(fixture.calls, "utf8").length,
          rejectedSupersede = runSupersede(row.expected, row.extra),
          calls = readFileSync(fixture.calls, "utf8").slice(callsBefore);
        expect(rejectedSupersede.status, row.name).not.toBe(0);
        expect(calls, row.name).not.toMatch(
          /(?:^|\n)(?:pull |network disconnect|compose .* (?:stop|create|up)|start )/,
        );
        expect(readFileSync(recoveryPath, "utf8"), row.name).toBe(recoveryBefore);
        expect(readFileSync(metadataPath, "utf8"), row.name).toBe(metadataBefore);
        expect(readFileSync(markerPath, "utf8"), row.name).toBe(markerBefore);
      }
      seedSupersede();
      const preflightCallsStart = readFileSync(fixture.calls, "utf8").length,
        exactPreflight = spawnSync(
          deploy,
          ["--internal-supersede-preflight", target, deployTarget, runtimeEnvSha!],
          {
            cwd: root,
            env: {
              ...supersedeEnv,
              KRABS_REMOTE_PREFLIGHT: "1",
              SUPERSEDE_TEST: "1",
              OLD_TARGET_SHA: target,
              OLD_TARGET_IMAGE: oldDigest,
              OLD_API_SHA: target,
              OLD_API_IMAGE: oldDigest,
              OLD_API_REPLACED: oldApiReplaced,
              MANAGER_NETWORK_FENCED: managerNetworkFenced,
            },
            encoding: "utf8",
          },
        ),
        preflightCalls = readFileSync(fixture.calls, "utf8").slice(preflightCallsStart);
      expect(exactPreflight.status, exactPreflight.stderr).toBe(0);
      expect(preflightCalls).not.toMatch(/(?:^|\n)(?:pull |network disconnect|compose |start )/);

      const barrierDir = join(fixture.dir, "supersede-barriers");
      mkdirSync(barrierDir);
      sql(
        fixture.control,
        `INSERT INTO operator_commands(action,initiator_type,initiator,status,created_at) VALUES ('resume','system','deploy:${recoveryStateId}:resume','rejected','2026-09-07T07:42:48.319Z')`,
      );
      seedSupersede();
      const recoveryBeforeFenceDeath = readFileSync(recoveryPath, "utf8"),
        fenceDeath = runSupersede(target, {
          KRABS_DEPLOY_TEST_BARRIER_DIR: barrierDir,
          KRABS_DEPLOY_TEST_HARD_DEATH: "supersede-after-first-fence",
        });
      expect(fenceDeath.status).not.toBe(0);
      expect(readFileSync(recoveryPath, "utf8")).toBe(recoveryBeforeFenceDeath);
      const recoveredCallsStart = readFileSync(fixture.calls, "utf8").length;
      expect(runSupersede().status).toBe(0);
      expect(readFileSync(fixture.calls, "utf8").slice(recoveredCallsStart)).toContain(
        "network disconnect -f krabs_manager-net target-manager",
      );
      expect(
        rows(fixture).filter(
          (row: { action: string; initiator: string }) =>
            row.action === "resume" && row.initiator.startsWith(`deploy:${recoveryStateId}`),
        ),
      ).toEqual([
        expect.objectContaining({
          initiator: `deploy:${recoveryStateId}:resume`,
          status: "rejected",
        }),
        expect.objectContaining({
          initiator: `deploy:${recoveryStateId}:${deployTarget}:resume`,
          status: "applied",
        }),
      ]);

      seedSupersede();
      const rebindDeath = runSupersede(target, {
        KRABS_DEPLOY_TEST_BARRIER_DIR: barrierDir,
        KRABS_DEPLOY_TEST_HARD_DEATH: "supersede-after-rebind",
      });
      expect(rebindDeath.status).not.toBe(0);
      expect(JSON.parse(readFileSync(recoveryPath, "utf8"))).toMatchObject({
        recoveryStateId,
        targetSha: deployTarget,
        phase: "cutover_paused",
        prePaused: false,
        previousVersion: 0,
        targetRuntimeId: "",
        targetManagerId: "",
      });
      const exactRetry = spawnSync(deploy, ["--internal", "release", "retry"], {
        cwd: root,
        env: { ...supersedeEnv, SUPERSEDE_TEST: "1", OLD_API_REPLACED: oldApiReplaced },
        encoding: "utf8",
        timeout: 25_000,
      });
      expect(exactRetry.status, exactRetry.stderr).toBe(0);
      expect(exactRetry.stdout).toContain("DEPLOY_RECEIPT");
      expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toMatchObject({
        sha: deployTarget,
        recoveryStateId,
        receipt: { prePaused: false, effectivePaused: false },
      });
      expect(readFileSync(fixture.api, "utf8").trim()).toBe("false");
      seedSupersede();
      writeFileSync(fixture.env.NETWORK_FENCED, "fenced\n");
      const detachedSupersede = runSupersede();
      expect(detachedSupersede.status, detachedSupersede.stderr).toBe(0);
      expect(detachedSupersede.stdout).toContain("DEPLOY_RECEIPT");
      expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toMatchObject({
        deployVersion: 1,
        sha: deployTarget,
        recoveryStateId,
        runtimeEnvSha256: runtimeEnvSha,
      });
      seedSupersede();
      const callsBeforeSupersede = readFileSync(fixture.calls, "utf8").length,
        superseded = runSupersede(),
        supersedeCalls = readFileSync(fixture.calls, "utf8").slice(callsBeforeSupersede);
      expect(superseded.status, superseded.stderr).toBe(0);
      expect(superseded.stdout).toContain("DEPLOY_RECEIPT");
      expect(supersedeCalls.indexOf("pull ")).toBeLessThan(
        supersedeCalls.indexOf("network disconnect"),
      );
      expect(supersedeCalls.indexOf("network disconnect")).toBeLessThan(
        supersedeCalls.indexOf(" stop krabs-api"),
      );
      expect(supersedeCalls.indexOf(" stop krabs-api")).toBeLessThan(
        supersedeCalls.indexOf(" create --pull never"),
      );
      expect(supersedeCalls).toContain("order-gate pre");
      expect(supersedeCalls).toContain("order-gate post");
      expect(existsSync(recoveryPath)).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
      expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toMatchObject({
        deployVersion: 1,
        sha: deployTarget,
        recoveryStateId,
      });
      expect(
        spawnSync(
          deploy,
          ["--supersede-stopped-recovery", target, "--gate-evidence", "x", "extra"],
          { cwd: root, env, encoding: "utf8" },
        ).status,
      ).not.toBe(0);
      console.log("T28J_SUPERSEDE_STOPPED_RECOVERY");
      return;
    }
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
    await yieldToWorker();
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
          cwd: root,
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
      const killedCalls = readFileSync(fixture.calls, "utf8").slice(-4000);
      expect(
        killed.status,
        `${point} signal=${killed.signal} error=${killed.error?.message}\n${killedCalls}`,
      ).toBe(137);
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
      const refreshedRecovery = JSON.parse(readFileSync(recoveryPath, "utf8"));
      const expectedRecovery = JSON.parse(recoverySeed);
      expect(refreshedRecovery.controllerPid, mode).toBeGreaterThan(0);
      expect(refreshedRecovery.workerPgid, mode).toBeGreaterThan(0);
      for (const key of ["controllerPid", "controllerStartTicks", "workerPgid"]) {
        delete refreshedRecovery[key];
        delete expectedRecovery[key];
      }
      expect(refreshedRecovery, mode).toEqual(expectedRecovery);
      expect(readFileSync(markerPath, "utf8"), mode).toBe(markerSeed);
      expect(readFileSync(stagedRuntimeEnv, "utf8"), mode).toBe(boundSeed);
    }
    reached.add("negatives");
    await yieldToWorker();
    writeFileSync(recoveryPath, recoverySeed);
    writeFileSync(markerPath, markerSeed);
    writeFileSync(fixture.env.NETWORK_FENCED, "fenced\n");
    const beforeRetry = readFileSync(fixture.calls, "utf8").length;
    // prettier-ignore
    const retry = spawnSync(deploy, ["--rollback-state-id", state.rollbackStateId], { cwd: root, env: { ...env, DEPLOY_DIGEST: `sha256:${digest}`, DEPLOY_HEALTH_EXIT: "0" }, encoding: "utf8", timeout: 20_000 });
    expect(retry.status, retry.stderr).toBe(0);
    const reentryCalls = readFileSync(fixture.calls, "utf8").slice(beforeRetry);
    expect(reentryCalls).not.toMatch(/(?:^|\n)docker pull /);
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
    expect(statSync(join(config, "deploy-meta.json")).mode & 0o777).toBe(0o644);
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
    expect(metadata.receipt).toHaveProperty("migration101");
    expect(metadata.receipt).not.toHaveProperty("migration102");
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
    await yieldToWorker();
    rmSync(statePath, { force: true });
    rmSync(fixture.marker, { force: true });
    sql(fixture.control, "UPDATE runtime_control_state SET paused=1 WHERE id=1");
    writeFileSync(fixture.api, "true\n");
    writeFileSync(fixture.available, "yes\n");
    rmSync(fixture.env.NETWORK_FENCED, { force: true });
    rmSync(fixture.env.STOPPED, { force: true });
    const orderGate = join(fixture.dir, "order-status-gate"),
      orderGateCalls = join(fixture.dir, "order-status-gate-calls"),
      migrationRecoveryPath = join(config, "deploy-recovery.json"),
      migrationMarkerPath = join(config, "deploy-in-progress.json"),
      sentinelPath = join(config, "deploy-failstop-requested");
    writeFileSync(orderGateCalls, "");
    executable(
      orderGate,
      `echo "$1" >> "$ORDER_GATE_CALLS"
echo "order-gate $1" >> "$CALLS"
[[ "\${ORDER_GATE_FAIL:-}" == "$1" ]] && exit 41
[[ "$1" == post && ! -e "$API_AVAILABLE" ]] && exit 42
[[ "$1" == post ]] && marker=true || marker=false
[[ "\${ORDER_GATE_MALFORMED:-}" == "$1" ]] && rows103=bad || rows103='${"e".repeat(64)}'
printf '{"migration101":{"candidateCount":1,"candidateHash":"%s","rowsHash":"%s","markerWasPresent":%s},"migration102":{"markerWasPresent":false,"tableWasPresent":false,"rowCount":0,"rowsHash":"%s","schemaHash":"%s"},"migration103":{"markerWasPresent":false,"tableWasPresent":false,"rowCount":0,"rowsHash":"%s","schemaHash":"%s"},"migration106":{"candidateCount":4,"candidateHash":"%s","markerWasPresent":%s}}\\n' '${"a".repeat(64)}' '${"b".repeat(64)}' "$marker" '${"c".repeat(64)}' '${"d".repeat(64)}' "$rows103" '${"f".repeat(64)}' '${"9".repeat(64)}' "$marker"`,
    );
    const releaseEnv = {
        ...env,
        KRABS_REMOTE_CONTROLLER: "1",
        KRABS_REMOTE_SHA: deployTarget,
        KRABS_REMOTE_DIGEST: `sha256:${digest}`,
        KRABS_REMOTE_COMPOSE: compose,
        KRABS_REMOTE_ENV: runtimeEnv,
        KRABS_ORDER_STATUS_GATE: orderGate,
        ORDER_GATE_CALLS: orderGateCalls,
        DEPLOY_HEALTH_EXIT: "0",
      },
      runRelease = (extra: Record<string, string> = {}) =>
        spawnSync(
          "timeout",
          ["--signal=TERM", "--kill-after=2s", "20s", deploy, "--internal", "release", "test"],
          {
            cwd: root,
            env: { ...releaseEnv, ...extra },
            encoding: "utf8",
            timeout: 25_000,
          },
        ),
      watchDeploy = () =>
        spawnSync(guard, ["deploy-watch"], {
          env: {
            ...fixture.env,
            KRABS_DEPLOY_RECOVERY_PATH: migrationRecoveryPath,
            KRABS_DEPLOY_METADATA_PATH: metadataPath,
            KRABS_DEPLOY_FAILSTOP_PATH: sentinelPath,
            KRABS_DEPLOY_FAILSTOP_LOCK_PATH: join(fixture.dir, "deploy-failstop.lock"),
            KRABS_DEPLOY_LOCK_PATH: join(fixture.dir, "deploy-controller.lock"),
          },
          encoding: "utf8",
          timeout: 20_000,
        }),
      hardDeathRelease = (point: string) => {
        const barriers = join(fixture.dir, `barriers-${point}`);
        mkdirSync(barriers);
        return spawnSync(
          "timeout",
          [
            "--signal=TERM",
            "--kill-after=2s",
            "20s",
            "/bin/bash",
            "-c",
            '"$@" & child=$!; wait "$child"; code=$?; exit "$code"',
            "bash",
            deploy,
            "--internal",
            "release",
            "test",
          ],
          {
            cwd: root,
            env: {
              ...releaseEnv,
              KRABS_DEPLOY_TEST_BARRIER_DIR: barriers,
              KRABS_DEPLOY_TEST_HARD_DEATH: point,
            },
            encoding: "utf8",
            timeout: 25_000,
          },
        );
      };

    const failedPre = runRelease({ ORDER_GATE_FAIL: "pre" });
    expect(failedPre.status, failedPre.stderr).not.toBe(0);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe("cutover_paused");
    expect(existsSync(fixture.available)).toBe(false);
    const watchedPre = watchDeploy();
    expect(
      watchedPre.status,
      `${watchedPre.stderr} signal=${watchedPre.signal} error=${watchedPre.error?.message}\n${readFileSync(fixture.calls, "utf8").slice(-3000)}`,
    ).toBe(0);
    const preRetry = runRelease();
    expect(
      preRetry.status,
      `${preRetry.stderr}\n${readFileSync(fixture.calls, "utf8").slice(-6000)}`,
    ).toBe(0);
    expect(preRetry.stdout).toContain("DEPLOY_RECEIPT");
    const releaseReceipt = JSON.parse(
      preRetry.stdout
        .split("\n")
        .find((line) => line.startsWith("DEPLOY_RECEIPT "))!
        .replace("DEPLOY_RECEIPT ", ""),
    );
    expect(
      Object.keys(releaseReceipt)
        .filter((key) => key.startsWith("migration"))
        .sort(),
    ).toEqual(["migration101", "migration102", "migration103", "migration106"]);
    expect(releaseReceipt.migration101).toMatchObject({ candidateCount: 1 });
    expect(releaseReceipt.migration102).toMatchObject({ rowCount: 0, tableWasPresent: false });
    expect(releaseReceipt.migration103).toMatchObject({ rowCount: 0, tableWasPresent: false });
    expect(releaseReceipt.migration106).toMatchObject({ candidateCount: 4 });

    writeFileSync(orderGateCalls, "");
    const killedPre = hardDeathRelease("migration_gate_pre");
    expect(killedPre.status).toBe(137);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe(
      "migration_gate_pre",
    );
    expect(watchDeploy().status).toBe(0);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe(
      "migration_gate_pre",
    );
    expect(existsSync(sentinelPath)).toBe(true);
    const preDeathRetry = runRelease();
    expect(preDeathRetry.status, preDeathRetry.stderr).toBe(0);
    expect(readFileSync(orderGateCalls, "utf8").trim().split("\n")).toEqual(["pre", "pre", "post"]);
    expect(existsSync(migrationRecoveryPath)).toBe(false);
    expect(existsSync(sentinelPath)).toBe(false);

    writeFileSync(orderGateCalls, "");
    const killedBeforeApi = hardDeathRelease("after-target-started-before-api");
    expect(killedBeforeApi.status).toBe(137);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe("target_started");
    expect(existsSync(fixture.available)).toBe(false);
    const beforeTargetStartedWatch = readFileSync(fixture.calls, "utf8").length;
    const watchedBeforeApi = watchDeploy();
    expect(watchedBeforeApi.status, watchedBeforeApi.stderr).toBe(0);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe(
      "target_stopped_rearbitrate",
    );
    const targetStartedRetry = runRelease();
    expect(targetStartedRetry.status, targetStartedRetry.stderr).toBe(0);
    expect(targetStartedRetry.stdout).toContain("DEPLOY_RECEIPT");
    const targetStartedCalls = readFileSync(fixture.calls, "utf8").slice(beforeTargetStartedWatch);
    expect(targetStartedCalls.indexOf("up -d --no-deps --pull never krabs-api")).toBeLessThan(
      targetStartedCalls.indexOf("order-gate post"),
    );
    expect(targetStartedCalls.indexOf("order-gate post")).toBeLessThan(
      targetStartedCalls.indexOf("start id-krabs-runtime"),
    );
    expect(readFileSync(fixture.api, "utf8").trim()).toBe("true");
    expect(existsSync(migrationRecoveryPath)).toBe(false);
    reached.add("target-started-recovery");
    await yieldToWorker();

    const failedPost = runRelease({ ORDER_GATE_FAIL: "post" });
    expect(failedPost.status, failedPost.stderr).not.toBe(0);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe("target_started");
    expect(readFileSync(fixture.api, "utf8").trim()).toBe("true");
    const watchedPost = watchDeploy();
    expect(watchedPost.status, watchedPost.stderr).toBe(0);
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8")).phase).toBe(
      "target_stopped_rearbitrate",
    );
    expect(existsSync(fixture.env.STOPPED)).toBe(true);
    const postRetry = runRelease();
    expect(postRetry.status, postRetry.stderr).toBe(0);
    expect(postRetry.stdout).toContain("DEPLOY_RECEIPT");
    expect(existsSync(migrationRecoveryPath)).toBe(false);
    expect(existsSync(migrationMarkerPath)).toBe(false);
    reached.add("migration-gate-recovery");

    expect([...reached].sort()).toEqual([
      "attached-exact",
      "env-mismatch",
      "legacy-guard",
      "migration-gate-recovery",
      "negatives",
      "outer-preflight",
      "target-started-recovery",
      "zero-connect",
    ]);
    const malformedProof = runRelease({ ORDER_GATE_MALFORMED: "post" });
    expect(malformedProof.status).not.toBe(0);
    expect(malformedProof.stdout).not.toContain("DEPLOY_RECEIPT");
    expect(JSON.parse(readFileSync(migrationRecoveryPath, "utf8"))).toMatchObject({
      phase: "arbitration_boundary",
      migrationGate: { mode: "post", migration103: { rowsHash: "bad" } },
    });
    console.log(
      "T28F_V25 legacy-guard outer-preflight env-mismatch zero-connect attached-exact negatives migration-gate-recovery",
    );
  };
  it("T28i — selective rollback Git-object boundary", () => {
    const clearedRuntimeIdentity = makeFixture(false);
    sql(
      clearedRuntimeIdentity.control,
      "UPDATE runtime_control_state SET current_run_id='',current_instance_id='' WHERE id=1;",
    );
    const cutover = run(clearedRuntimeIdentity, "deploy-cutover", "cleared-runtime-identity");
    expect(cutover.status, cutover.stderr).toBe(0);
    expect(JSON.parse(cutover.stdout)).toMatchObject({ effectivePaused: true });
    expect(sql(clearedRuntimeIdentity.control, "SELECT paused FROM runtime_control_state;")).toBe(
      "1",
    );
    const deploySource = readFileSync(deploy, "utf8");
    const guardSource = readFileSync(guard, "utf8");
    expect(deploySource).not.toContain("{{.Username}}");
    expect(deploySource).toContain('d.auths?.["ghcr.io"]');
    expect(deploySource).not.toContain('Labels \\"org.opencontainers.image.revision');
    expect(deploySource).not.toContain("datetime.UTC");
    expect(guardSource).not.toContain("datetime.UTC");
    expect(deploySource).toContain(
      'resolved="$(command -v "${KRABS_DEPLOY_TIMEOUT:-timeout}" || true)"',
    );
    expect(deploySource.match(/TIMEOUT="\$\(local_timeout\)"/g)).toHaveLength(3);
    const supersedeDeadline = deploySource.slice(
      deploySource.indexOf("deadline_supersede()"),
      deploySource.indexOf("main()"),
    );
    expect(supersedeDeadline.indexOf("preflight_supersede_recovery")).toBeGreaterThan(-1);
    expect(supersedeDeadline.indexOf("preflight_supersede_recovery")).toBeLessThan(
      supersedeDeadline.indexOf("stage_and_publish"),
    );
    const supersedePreflight = deploySource.slice(
      deploySource.indexOf("preflight_supersede_recovery()"),
      deploySource.indexOf("stage_runtime_env()"),
    );
    expect(supersedePreflight).toContain(
      "KRABS_ORDER_STATUS_GATE='${SERVER_PATH}/config/krabs-order-status-migration-gate-${expected_old}.sh'",
    );
    expect(supersedePreflight).toContain("KRABS_REMOTE_SHA='${full}' KRABS_REMOTE_PREFLIGHT=1");
    expect(deploySource).not.toContain("KRABS_DEPLOY_TIMEOUT:-/usr/bin/timeout");
    expect(deploySource).toContain("compose create --pull never");
    expect(deploySource).toContain("compose up -d --no-deps --pull never");
    expect(deploySource).not.toContain("install -d -m 700 '${root}/config'");
    expect(deploySource.match(/install -d -m 711 '\$\{root\}\/config'/g)).toHaveLength(2);
    expect(guardSource).toContain('auth=(-H "Authorization: Bearer $key")');
    expect(guardSource).toContain(
      'local POLL_ATTEMPTS="${KRABS_DEPLOY_ARBITRATION_POLL_ATTEMPTS:-300}"',
    );
    expect(guardSource).toContain(
      'command_timeout="${KRABS_DEPLOY_ARBITRATION_TIMEOUT_SECONDS:-630}"',
    );
    const retryOwnershipRefresh = deploySource.indexOf(
      "d.update(controllerPid=int(sys.argv[2]),controllerStartTicks=sys.argv[3],workerPgid=int(sys.argv[4]))",
    );
    expect(retryOwnershipRefresh).toBeGreaterThan(-1);
    expect(retryOwnershipRefresh).toBeLessThan(deploySource.indexOf('classify_recovery "$full"'));
    const rollbackStateDirectory = deploySource.indexOf(
      'mkdir -p "$CONFIG_DIR" "$(dirname "$ROLLBACK_OPERATION_LOCK")"',
    );
    expect(rollbackStateDirectory).toBeGreaterThan(-1);
    expect(rollbackStateDirectory).toBeLessThan(
      deploySource.indexOf('take "$ROLLBACK_OPERATION_LOCK"'),
    );
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
    const hashWithoutTimeout = spawnSync(deploy, ["--print-gate-input-hash"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, KRABS_DEPLOY_TIMEOUT: join(repo, "missing-timeout") },
    });
    expect(hashWithoutTimeout.status, hashWithoutTimeout.stderr).toBe(0);
    git("branch", "-M", "master");
    git("update-ref", "refs/remotes/origin/master", base);
    const gateEvidence = () => {
      const dir = join(repo, "gate-evidence");
      // prettier-ignore
      let names=["baseline-test.log","baseline-lint.log","gate-cases.txt","typecheck.log","build.log","post-test.log","post-lint.log","prettier.log","gate-summary.json","test-census.json",...Array.from({length:5},(_,n)=>`focused-${n + 2}.log`)];
      const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      const counts = (passed: number) => ({ passed, failed: 0, skipped: 0, total: passed });
      // prettier-ignore
      const packageDeltas = { "@krabs/runtime": [3, 12], "@krabs/db": [1, 4], "@krabs/config": [0, 0] } as const;
      mkdirSync(dir);
      writeFileSync(join(repo, ".git", "info", "exclude"), "gate-evidence/\n");
      for (const name of names)
        writeFileSync(
          join(dir, name),
          name.startsWith("focused-") ? "Test Files  1 passed (1)\nTests  1 passed (1)\n" : "ok\n",
        );
      const testLog = (post = false, regress = false) =>
        Object.entries(packageDeltas)
          .flatMap(([name, [files, tests]]) => [
            `${name}:test: Test Files  ${10 + (post ? files : 0) - (regress && name === "@krabs/runtime" ? 1 : 0)} passed (${10 + (post ? files : 0) - (regress && name === "@krabs/runtime" ? 1 : 0)})`,
            `${name}:test: Tests  ${100 + (post ? tests : 0) - (regress && name === "@krabs/runtime" ? 1 : 0)} passed (${100 + (post ? tests : 0) - (regress && name === "@krabs/runtime" ? 1 : 0)})`,
          ])
          .join("\n") + "\n";
      const lintLog =
        "@krabs/config:lint: > eslint\n@krabs/runtime:lint: 33 problems (0 errors, 33 warnings)\n@krabs/scripts:lint: 116 problems (0 errors, 116 warnings)\n";
      const postLintLog =
        "@krabs/config:lint: > eslint\n@krabs/scripts:lint: 116 problems (0 errors, 116 warnings)\n@krabs/runtime:lint: 33 problems (0 errors, 33 warnings)\n";
      writeFileSync(join(dir, "baseline-test.log"), testLog());
      writeFileSync(join(dir, "post-test.log"), `Tasks: 15 successful, 15 total\n${testLog(true)}`);
      writeFileSync(join(dir, "baseline-lint.log"), `Tasks: 9 successful, 9 total\n${lintLog}`);
      writeFileSync(join(dir, "post-lint.log"), `Tasks: 9 successful, 9 total\n${postLintLog}`);
      writeFileSync(join(dir, "typecheck.log"), "Tasks: 15 successful, 15 total\n");
      writeFileSync(join(dir, "build.log"), "Tasks: 9 successful, 9 total\n");
      writeFileSync(join(dir, "prettier.log"), "All matched files use Prettier code style!\n");
      // prettier-ignore
      writeFileSync(join(dir,"gate-cases.txt"),"T1 T2 T3 T4 T5 T6 T7 T8 T9 T10a T10b T11 T12 T13 T13b T13d T14 T14b T15 T16 T17 T18a T18b-core T18b-log T18c T19 T20 T21a T21b T21c T22 T23 T24 T25 T26 T27 T28a T28b T28c T28d T28e T28f T28g T28h T28i T28j".split(" ").map(tag=>`${tag} — ok`).join("\n"));
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
      const writeCensus = (post: Record<string, readonly [number, number]> = packageDeltas) =>
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
              Object.entries(post).map(([key, [files, tests]]) => [
                key,
                { files: counts(10 + files), tests: counts(100 + tests) },
              ]),
            ),
          }),
        );
      writeCensus();
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
      writeFileSync(
        join(dir, "baseline-lint.log"),
        `Tasks: 9 successful, 9 total\n${lintLog.replace(
          "@krabs/config:lint: > eslint\n",
          "@krabs/config:lint: > eslint\n@krabs/config:lint: 1 problem (0 errors, 1 warning)\n",
        )}`,
      );
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).toBe(0);
      writeFileSync(join(dir, "baseline-lint.log"), `Tasks: 9 successful, 9 total\n${lintLog}`);
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
        join(dir, "post-test.log"),
        `Tasks: 15 successful, 15 total\n${testLog(true).replace("112 passed (112)", "112 passed (113)")}`,
      );
      writeCensus();
      const inconsistentCensus = JSON.parse(readFileSync(join(dir, "test-census.json"), "utf8"));
      inconsistentCensus.post["@krabs/runtime"].tests.total = 113;
      writeFileSync(join(dir, "test-census.json"), JSON.stringify(inconsistentCensus));
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "post-test.log"), `Tasks: 15 successful, 15 total\n${testLog(true)}`);
      writeCensus();
      writeFileSync(
        join(dir, "post-test.log"),
        `Tasks: 15 successful, 15 total\n${testLog(false, true)}`,
      );
      writeCensus({ "@krabs/runtime": [-1, -1], "@krabs/db": [0, 0], "@krabs/config": [0, 0] });
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "post-test.log"), `Tasks: 15 successful, 15 total\n${testLog(true)}`);
      writeCensus();
      writeFileSync(
        join(dir, "post-lint.log"),
        `Tasks: 9 successful, 9 total\n${postLintLog.replace("116 warnings", "117 warnings")}`,
      );
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "post-lint.log"), `Tasks: 9 successful, 9 total\n${postLintLog}`);
      writeFileSync(
        join(dir, "post-lint.log"),
        `Tasks: 9 successful, 9 total\n${postLintLog.replace("33 problems (0 errors, 33 warnings)", "1 problem (1 error, 1 warning)")}`,
      );
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "post-lint.log"), `Tasks: 9 successful, 9 total\n${postLintLog}`);
      writeFileSync(
        join(dir, "post-lint.log"),
        `Tasks: 9 successful, 9 total\n${postLintLog}@krabs/config:lint: 1 problem (0 errors, 1 warning)\n`,
      );
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      writeFileSync(join(dir, "post-lint.log"), `Tasks: 9 successful, 9 total\n${postLintLog}`);
      names = names.filter((name) => !name.startsWith("focused-"));
      manifest();
      expect(
        spawnSync(deploy, ["--verify-gate-evidence-only", evidence], {
          cwd: repo,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
      names = [...names, ...Array.from({ length: 5 }, (_, n) => `focused-${n + 2}.log`)];
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
