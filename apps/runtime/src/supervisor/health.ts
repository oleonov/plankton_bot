import type { RuntimeModule, RuntimePhase } from "@plankton/domain";

export interface HealthSnapshot {
  phase: RuntimePhase;
  paused: boolean;
  modules: Record<string, { ok: boolean; detail?: string }>;
  timestamp: number;
}

export async function collectHealth(
  phase: RuntimePhase,
  paused: boolean,
  modules: Array<[string, RuntimeModule]>,
): Promise<HealthSnapshot> {
  const moduleHealth: Record<string, { ok: boolean; detail?: string }> = {};

  for (const [name, mod] of modules) {
    try {
      moduleHealth[name] = await mod.healthCheck();
    } catch {
      moduleHealth[name] = { ok: false, detail: "healthCheck threw" };
    }
  }

  return {
    phase,
    paused,
    modules: moduleHealth,
    timestamp: Date.now(),
  };
}
