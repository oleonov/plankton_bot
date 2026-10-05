import { mkdtempSync, realpathSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync, fork, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { bootstrapLedgerDb } from "@krabs/db";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { EvidenceStore, familyBytes } from "../store.js";
import { LIMITS, counters, type MainMessage, type WorkerMessage } from "../types.js";
import { compiled, buildCompiledFixtures } from "./native-fixture.js";

let dir: string;
const children = new Set<ChildProcess>();
beforeAll(buildCompiledFixtures, 65_000);
function launch(path: string, ledgerPath: string): ChildProcess {
  const worker = fork(new URL(compiled("worker")), [], {
    execArgv: [],
    env: {},
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.add(worker);
  worker.once("exit", () => children.delete(worker));
  worker.send({ type: "init", path, ledgerPath, parentPid: process.pid });
  return worker;
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "exit-evidence-native-")));
});
afterEach(async () => {
  for (const worker of children) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGKILL");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
});
function child(source: string, args: string[] = []): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source, ...args], {
    cwd: process.cwd(),
    env: {},
    timeout: 15_000,
    encoding: "utf8",
    maxBuffer: 65_536,
  });
}
function receive(worker: ChildProcess): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker ACK timeout")), 3_000);
    worker.once("message", (m: WorkerMessage) => {
      clearTimeout(timer);
      resolve(m);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
it("compiled worker writes typed rows, refuses online readers, drains and releases ownership", async () => {
  const ledgerPath = join(dir, "ledger.db");
  bootstrapLedgerDb(ledgerPath).close();
  const path = join(dir, "exit-evidence.db");
  const worker = launch(path, ledgerPath);
  const ready = await receive(worker);
  expect(ready.type).toBe("ready");
  const blocked = new Database(path, { readonly: true, timeout: 0 });
  expect(() => blocked.prepare("SELECT * FROM run_state").get()).toThrow(/locked/);
  blocked.close();
  const now = Date.now();
  const ledger = new Database(ledgerPath);
  const iso = new Date(now).toISOString();
  ledger.exec(`INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,size_usdc,bot_run_id)
    VALUES('order','client','token','condition','buy','GTC',.1,10,1,'run');
    INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc)
    VALUES('fill','order','token','condition','buy',.1,10,1);`);
  ledger
    .prepare(
      "INSERT INTO positions(position_id,token_id,condition_id,side,size,opened_at,updated_at) VALUES('position','token','condition','buy',10,?,?)",
    )
    .run(iso, iso);
  ledger.exec(`INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id)
    VALUES('lot-fill','position','token','buy',10,10,.1,1,'fill')`);
  ledger.close();
  const ack = receive(worker);
  worker.send({
    type: "batch",
    grant: true,
    drops: counters(),
    packets: [
      {
        slot: 1,
        kind: "PlaceOrderRequested",
        id: "cmd",
        source: now,
        received: now,
        facts: {
          source: "strategy",
          side: "buy",
          clientOrderId: "client",
          commandId: "cmd",
          signalId: "sig",
          tokenId: "token",
          conditionId: "condition",
          price: 0.1,
          size: 10,
        },
      },
      {
        slot: 1,
        kind: "FillReceived",
        id: "fill",
        source: now,
        received: now,
        facts: {
          tokenId: "token",
          conditionId: "condition",
          clientOrderId: "client",
          orderId: "order",
          fillId: "fill",
          side: "buy",
        },
      },
      {
        slot: 1,
        kind: "PositionUpdated",
        id: "position",
        source: now,
        received: now,
        facts: {
          tokenId: "token",
          conditionId: "condition",
          positionId: "position",
          status: "open",
        },
      },
      {
        slot: 1,
        kind: "PlaceOrderRequested",
        id: "exit",
        source: now,
        received: now,
        facts: {
          tokenId: "token",
          conditionId: "condition",
          positionId: "position",
          source: "strategy",
          side: "sell",
          commandId: "exit",
          clientOrderId: "exit-client",
        },
      },
    ],
  } satisfies MainMessage);
  expect((await ack).type).toBe("ack");
  const changedLedger = new Database(ledgerPath);
  changedLedger.exec("UPDATE positions SET status='closed',size=0 WHERE position_id='position'");
  changedLedger.close();
  let progress = await receive(worker);
  for (
    let slice = 1;
    slice < 4 && progress.type === "progress" && !progress.episodes[0]!.terminal;
    slice++
  ) {
    worker.send({ type: "progressAck" });
    progress = await receive(worker);
  }
  expect(progress.type).toBe("progress");
  if (progress.type !== "progress") throw new Error("missing background progress");
  expect(progress.episodes[0]!.terminal).toBe(1);
  expect(progress.run.event_count).toBeGreaterThan(4);
  const stopped = receive(worker);
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  worker.send({ type: "shutdown" });
  expect((await stopped).type).toBe("stopped");
  await exited;
  const offline = new Database(path, { readonly: true });
  expect(
    (offline.prepare("SELECT clean_shutdown FROM run_state").get() as { clean_shutdown: number })
      .clean_shutdown,
  ).toBe(1);
  offline.close();
  const store = new EvidenceStore(path, Date.now());
  try {
    expect(store.run().spent).toBe(2);
    expect(store.episodes()).toHaveLength(1);
    expect(store.episodes()[0]!.position).toBe("position");
    expect(
      store.db
        .prepare("SELECT id FROM events WHERE stable_id='exit' AND kind='PlaceOrderRequested'")
        .get(),
    ).toBeDefined();
    expect(
      (
        store.db.prepare("SELECT count FROM quality WHERE reason='link_unknown'").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  } finally {
    store.close();
  }
  const summary = JSON.parse(
    execFileSync(process.execPath, [resolve("dist/scripts/exit-evidence-readout.js"), path], {
      encoding: "utf8",
    }),
  );
  expect(summary.episodes[0].position).toBe("position");
  expect(summary.evidenceRows).toBeGreaterThanOrEqual(4);
});

it("native SQLite throw stays in the child; timeout kill releases ownership within parent shutdown budget", () => {
  for (const nativeMs of [1200, 5000, 6000, 7000]) {
    const source = nativeParentSource(false);
    const result = JSON.parse(
      child(source, [
        compiled("module"),
        compiled("worker"),
        compiled("store"),
        join(dir, "exit-evidence.db"),
        join(dir, `lock-${nativeMs}.db`),
        String(nativeMs),
      ]),
    );
    expect(result.launches).toBe(1);
    expect(result.waited).toBeLessThan(2100);
    expect(result.nativeThrown).toBe(nativeMs === 1200);
    expect(result.released).toBe(true);
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}, 15_000);

// The injected query is actual native SQLite busy waiting, followed by SQLITE_BUSY.
// The production child entrypoint (including its parent-death watchdog) remains in use.
function nativeParentSource(exitImmediately: boolean): string {
  return (
    `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import Database from 'better-sqlite3';
    import { InProcessEventBus } from '@krabs/event-bus';
    const [moduleUrl, workerUrl, storeUrl, path, ledgerPath, nativeMs] = process.argv.slice(1);
    const { ExitEvidenceModule } = await import(moduleUrl);
    const { EvidenceStore } = await import(storeUrl);
    const lock = nativeMs === "external" ? null : new Database(ledgerPath);
    lock?.exec('CREATE TABLE locked(x); BEGIN EXCLUSIVE');
    const fixture = \`
      import Database from 'better-sqlite3';
      const [workerUrl,storeUrl,ledgerPath,nativeMs]=process.argv.slice(1);
      const {EvidenceStore}=await import(storeUrl);
      EvidenceStore.prototype.recover=function(){
        const ledger=new Database(ledgerPath,{timeout:nativeMs === "external" ? 10000 : Number(nativeMs)});
        process.send({type:'native_entered'});
        try { ledger.prepare('SELECT * FROM locked').get(); }
        catch(e) { process.send({type:'native_throw',code:e.code}); throw e; }
        finally { ledger.close(); }
      };
      await import(workerUrl);
    \`;
    let launches=0, worker, nativeThrown=false;
    let entered; const inNative=new Promise(resolve=>entered=resolve);
    const module=new ExitEvidenceModule({bus:new InProcessEventBus(),ledgerPath,log:{info(){}},
      book:()=>({book:null,fresh:false}),workerFactory:()=>{
        launches++;
        worker=spawn(process.execPath,['--input-type=module','-e',fixture,workerUrl,storeUrl,ledgerPath,nativeMs],
          {env:{},serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
        worker.on('message',m=>{
          if(m.type==='native_entered')entered();
          if(m.type==='native_throw'){assert.equal(m.code,'SQLITE_BUSY');nativeThrown=true;}
        });
        return worker;
      }});
    await module.start(); await inNative;
    assert.throws(()=>new EvidenceStore(path,Date.now()),/locked/);
    const began=performance.now();
    ` +
    (exitImmediately
      ? "process.stdout.write(String(worker.pid)); process.exit(0);"
      : String.raw`
    if(nativeMs === '6000') worker.disconnect();
    if(nativeMs === '7000') worker.kill('SIGKILL');
    await module.stop(); const waited=performance.now()-began;
    await module.start(); assert.equal(launches,1);
    assert(worker.exitCode!==null || worker.signalCode!==null);
    lock?.exec('ROLLBACK'); lock?.close();
    const reopened=new EvidenceStore(path,Date.now()); reopened.close();
    process.stdout.write(JSON.stringify({waited,launches,nativeThrown,released:true}));`)
  );
}

it.each(["exit", "crash"])(
  "parent %s during native SQLite survives and the watchdog kills the orphan before any second writer",
  async (mode) => {
    const path = join(dir, "exit-evidence.db");
    // The grandparent holds this lock through parent death: native cannot return
    // merely because the dying parent released its own ledger connection.
    const lockPath = join(dir, "locked.db");
    const lock = new Database(lockPath);
    lock.exec("CREATE TABLE locked(x); BEGIN EXCLUSIVE");
    let source = nativeParentSource(true);
    if (mode === "crash")
      source = source.replace("process.exit(0);", "process.kill(process.pid,'SIGKILL');");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        source,
        compiled("module"),
        compiled("worker"),
        compiled("store"),
        path,
        lockPath,
        "external",
      ],
      { env: {}, encoding: "utf8", timeout: 15_000 },
    );
    expect({
      status: result.status,
      signal: result.signal,
      nativeFatal: result.stderr.includes("FATAL ERROR"),
    }).toEqual({
      status: mode === "exit" ? 0 : null,
      signal: mode === "exit" ? null : "SIGKILL",
      nativeFatal: false,
    });
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    await waitForDeath(pid);
    lock.exec("ROLLBACK");
    lock.close();
    const store = new EvidenceStore(path, Date.now());
    store.close();
  },
);
async function waitForDeath(pid: number): Promise<void> {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`child ${pid} survived parent`);
}

it("process crash after local credit consumption but before persistence spends its slot forever", async () => {
  const source = String.raw`
    import { fork } from 'node:child_process';
    import { InProcessEventBus } from '@krabs/event-bus';
    const [moduleUrl,workerUrl,ledgerPath]=process.argv.slice(1);
    const { ExitEvidenceModule }=await import(moduleUrl);
    const bus=new InProcessEventBus(); let worker;
    const module=new ExitEvidenceModule({bus,ledgerPath,log:{info(){}},book:()=>({book:null,fresh:false}),
      workerFactory:()=>worker=fork(new URL(workerUrl),[],{env:{},execArgv:[],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']})});
    await module.start(); worker.on('message',m=>{
      if(m.type!=='ready')return;
      void bus.publish('PlaceOrderRequested',{timestamp:Date.now(),command:{source:'strategy',side:'buy',
        commandId:'cmd',clientOrderId:'client',signalId:'sig',tokenId:'token',conditionId:'condition'}});
      if(module.stats().episodes!==1)process.exit(3);
      process.stdout.write(String(worker.pid)); process.exit(0);
    });`;
  const ledgerPath = join(dir, "ledger.db");
  bootstrapLedgerDb(ledgerPath).close();
  const pid = Number(child(source, [compiled("module"), compiled("worker"), ledgerPath]));
  await waitForDeath(pid);
  const store = new EvidenceStore(join(dir, "exit-evidence.db"), Date.now());
  try {
    expect(store.run().spent).toBe(1);
    expect(store.episodes()).toHaveLength(0);
    expect(store.credit(Date.now())).toBe(2);
  } finally {
    store.close();
  }
});

it("on-disk quotas fit, max_page_count throws SQLITE_FULL, rollback-journal peak stays within 520 MiB", () => {
  const start = performance.now();
  const cpu = process.cpuUsage();
  const usage = process.resourceUsage();
  const path = join(dir, "exit-evidence.db");
  const store = new EvidenceStore(path, Date.now());
  const db = store.db;
  let peak = 0;
  try {
    const insertBook = db.prepare(
      "INSERT INTO book_samples(event_key,slot,received,source,payload) VALUES(?,1,1,1,?)",
    );
    const insertEvent = db.prepare(
      "INSERT INTO events(slot,kind,stable_id,origin,received,source,client,order_id,fill_id,position,payload) VALUES(1,'PlaceOrderRequested',?,'recovered',1,1,?,?,?,?,?)",
    );
    const books = "x".repeat(1024);
    const events = "y".repeat(2048);
    let nextBook = 0;
    const addBook = () => insertBook.run(String(nextBook++).padStart(64, "0"), books);
    db.transaction(() => {
      for (let i = 0; i < LIMITS.books; i++) addBook();
    })();
    db.transaction(() => {
      for (let i = 0; i < LIMITS.events; i++) {
        const key = String(i).padStart(160, "x");
        insertEvent.run(key, key, key, key, key, events);
      }
    })();
    const quotaBytes = statSync(path).size;
    expect(quotaBytes).toBeLessThan(LIMITS.pages * LIMITS.pageSize);
    let full = false;
    while (!full) {
      try {
        db.transaction(() => {
          for (let i = 0; i < 256; i++) addBook();
        })();
      } catch (e) {
        expect((e as { code: string }).code).toBe("SQLITE_FULL");
        full = true;
      }
      peak = Math.max(peak, familyBytes(path));
    }
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE book_samples SET event_key=event_key,payload=?").run("z".repeat(1024));
    db.prepare(
      "UPDATE events SET stable_id=stable_id,client=client,order_id=order_id,payload=?",
    ).run("q".repeat(2048));
    peak = Math.max(peak, familyBytes(path));
    expect(existsSync(path + "-journal")).toBe(true);
    expect(peak).toBeLessThanOrEqual(LIMITS.familyBytes);
    db.exec("ROLLBACK");
    expect(
      (db.prepare("SELECT payload FROM book_samples LIMIT 1").get() as { payload: string }).payload,
    ).toBe(books);
    expect(db.pragma("max_page_count", { simple: true })).toBe(65_536);
    expect(db.pragma("page_size", { simple: true })).toBe(4_096);
    expect(existsSync(path + "-wal")).toBe(false);
    db.function("measure_family", () => {
      peak = Math.max(peak, familyBytes(path));
      return 0;
    });
    db.exec(`CREATE TEMP TRIGGER expiry_peak AFTER DELETE ON book_samples
      WHEN OLD.id % 512 = 0 BEGIN SELECT measure_family(); END;`);
    store.batch([], counters(), store.run().expires);
    expect(peak).toBeLessThanOrEqual(LIMITS.familyBytes);
    expect((db.prepare("SELECT count(*) AS n FROM book_samples").get() as { n: number }).n).toBe(0);
    const cost = process.cpuUsage(cpu),
      io = process.resourceUsage();
    process.stdout.write(
      JSON.stringify({
        quotaBytes,
        familyPeakBytes: peak,
        maxMainBytes: 268435456,
        wallMs: performance.now() - start,
        cpuUserMs: cost.user / 1000,
        cpuSystemMs: cost.system / 1000,
        fsReadBlocks: io.fsRead - usage.fsRead,
        fsWriteBlocks: io.fsWrite - usage.fsWrite,
      }) + "\n",
    );
  } finally {
    store.close();
  }
}, 60_000);

it("recovers an interrupted transaction after OS process death without reusing committed credits", () => {
  const path = join(dir, "exit-evidence.db");
  const source = String.raw`
    const [url,path]=process.argv.slice(1); const {EvidenceStore}=await import(url);
    const store=new EvidenceStore(path,Date.now()); store.credit(Date.now());
    store.db.exec('BEGIN IMMEDIATE; UPDATE run_state SET spent=32;');
    process.kill(process.pid,'SIGKILL');`;
  expect(() => child(source, [compiled("store"), path])).toThrow();
  const store = new EvidenceStore(path, Date.now());
  try {
    expect(store.run().spent).toBe(1);
    expect(store.credit(Date.now())).toBe(2);
  } finally {
    store.close();
  }
});

it.each(["counter", "lineage"])(
  "OS death at recovered %s commit boundary rolls back facts and lineage, then retry commits once",
  (boundary) => {
    const path = join(dir, "exit-evidence.db");
    const ledgerPath = join(dir, "ledger.db");
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const ledger = bootstrapLedgerDb(ledgerPath);
    ledger.db
      .prepare(
        `INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,size_usdc,status,bot_run_id,updated_at)
    VALUES('order','client','token','condition','buy','GTC',.1,10,1,'filled','run',?)`,
      )
      .run(iso);
    ledger.db
      .prepare(
        `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
    VALUES('fill','order','token','condition','buy',.1,10,1,?)`,
      )
      .run(iso);
    ledger.db
      .prepare(
        `INSERT INTO positions(position_id,token_id,condition_id,side,size,status,opened_at,updated_at)
    VALUES('position','token','condition','buy',0,'closed',?,?)`,
      )
      .run(iso, iso);
    ledger.db
      .exec(`INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id)
    VALUES('lot-fill','position','token','buy',10,10,.1,1,'fill')`);
    ledger.close();
    const source = String.raw`
    const [url,path,ledgerPath,boundary,time]=process.argv.slice(1);
    const {EvidenceStore}=await import(url); const now=Number(time);
    const store=new EvidenceStore(path,now); store.credit(now);
    const base={slot:1,id:'cmd',source:now,received:now,facts:{source:'strategy',side:'buy',
      clientOrderId:'client',commandId:'cmd',signalId:'sig',tokenId:'token',conditionId:'condition'}};
    const fill={...base,kind:'FillReceived',id:'fill',facts:{...base.facts,orderId:'order',fillId:'fill'}};
    store.batch([{...base,kind:'PlaceOrderRequested'},fill],{},now);
    const prepare=store.db.prepare.bind(store.db);
    store.db.prepare=(sql)=>{
      if(sql.includes(boundary==='counter'?'event_count=event_count+1':'UPDATE episodes SET terminal') &&
        (boundary==='counter' || store.episodes()[0]?.position!==null))
        process.kill(process.pid,'SIGKILL');
      return prepare(sql);
    };
    store.recover(ledgerPath,now,[fill]);`;
    let interruption: unknown;
    try {
      child(source, [compiled("store"), path, ledgerPath, boundary, String(now)]);
    } catch (error) {
      interruption = error;
    }
    expect(interruption).toMatchObject({ signal: "SIGKILL" });
    const store = new EvidenceStore(path, now);
    try {
      const actual = () =>
        (store.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
      expect(store.run().event_count).toBe(2);
      expect(actual()).toBe(2);
      expect(store.episodes()[0]).toMatchObject({ position: null, terminal: 0, ambiguous: 0 });
      // Cursor slices may include the initial intent; repeated recovery is idempotent.
      for (let i = 0; i < 3; i++) store.recover(ledgerPath, now);
      expect(store.run().event_count).toBe(5);
      expect(actual()).toBe(5);
      expect(store.episodes()[0]).toMatchObject({ position: "position", terminal: 1 });
      expect(store.run().spent).toBe(1);
    } finally {
      store.close();
    }
  },
);

it("an injected ENOSPC filesystem failure disables only the optional worker and closes cleanly", async () => {
  const worker = fork(new URL(compiled("worker")), [], {
    execArgv: [
      "--import",
      "data:text/javascript," +
        encodeURIComponent(`
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      fs.statfsSync=()=>{throw Object.assign(new Error('fixture'),{code:'ENOSPC'})};
      syncBuiltinESMExports();`),
    ],
    env: {},
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  worker.send({
    type: "init",
    parentPid: process.pid,
    path: join(dir, "exit-evidence.db"),
    ledgerPath: join(dir, "ledger.db"),
  });
  const messages: string[] = [];
  worker.on("message", (m: WorkerMessage) => messages.push(m.type));
  await new Promise((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
  expect(messages).toEqual(["disabled", "stopped"]);
});
