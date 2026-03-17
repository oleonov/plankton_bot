import type { RuntimeModule } from "@plankton/domain";
import type { Logger } from "../logger.js";

export function createPlaceholderModule(name: string, log: Logger): RuntimeModule {
  let started = false;
  const child = log.child({ module: name });

  return {
    async start(): Promise<void> {
      child.info("starting (placeholder — no-op)");
      started = true;
    },
    async stop(): Promise<void> {
      child.info("stopping (placeholder — no-op)");
      started = false;
    },
    async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
      return { ok: started, detail: started ? "placeholder running" : "not started" };
    },
  };
}
