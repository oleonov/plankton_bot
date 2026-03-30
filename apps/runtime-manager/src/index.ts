import pino from "pino";
import Docker from "dockerode";
import { bootstrapControlDb } from "@plankton/db";
import {
  SqliteSwitchRequestRepository,
  SqliteRuntimeControlStateRepository,
  SqliteStateTransitionRepository,
} from "@plankton/db";
import { SwitchDriver } from "./switch-driver.js";
import { DockerContainerControl } from "./container-control.js";

const log = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

function main(): void {
  const controlDbPath = process.env["CONTROL_DB_PATH"];
  if (!controlDbPath) throw new Error("CONTROL_DB_PATH required");

  const managedContainer =
    process.env["MANAGED_CONTAINER"] ?? "plankton-plankton-runtime-1";
  const pollIntervalMs = Number(process.env["POLL_INTERVAL_MS"]) || 3000;
  const restartTimeoutS = Number(process.env["RESTART_TIMEOUT_S"]) || 30;

  const conn = bootstrapControlDb(controlDbPath);

  const switchRepo = new SqliteSwitchRequestRepository(conn.db);
  const controlRepo = new SqliteRuntimeControlStateRepository(conn.db);
  const transitionRepo = new SqliteStateTransitionRepository(conn.db);

  const docker = new Docker();
  const container = new DockerContainerControl(docker, managedContainer);

  const driver = new SwitchDriver(
    conn.db,
    switchRepo,
    controlRepo,
    transitionRepo,
    container,
    restartTimeoutS,
    log,
  );

  log.info(
    { controlDbPath, managedContainer, pollIntervalMs },
    "runtime manager starting",
  );

  driver.recover();

  const timer = setInterval(() => {
    driver.tick().catch((err) => log.error({ err }, "switch tick error"));
  }, pollIntervalMs);

  const shutdown = () => {
    clearInterval(timer);
    conn.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
