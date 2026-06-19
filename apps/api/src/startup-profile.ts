import { assertSupportedRuntimeProfile, SUPPORTED_RUNTIME_PROFILE } from "@krabs/domain";

export interface StartupLedgerProfileInput {
  currentProfile: string | null | undefined;
  desiredProfile: string | null | undefined;
  envMode: string | null | undefined;
}

export function resolveStartupLedgerProfile(
  input: StartupLedgerProfileInput,
): typeof SUPPORTED_RUNTIME_PROFILE {
  const resolved = input.currentProfile ?? input.desiredProfile ?? input.envMode ?? null;
  try {
    assertSupportedRuntimeProfile(resolved);
  } catch (err) {
    const context = `current=${input.currentProfile ?? "null"}, desired=${
      input.desiredProfile ?? "null"
    }, env=${input.envMode ?? "null"}, resolved=${resolved ?? "null"}`;
    throw new Error(`${(err as Error).message} (${context})`);
  }
  return resolved;
}
