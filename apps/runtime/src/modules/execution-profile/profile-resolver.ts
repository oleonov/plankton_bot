import type { ExecutionProfileHysteresisBounds, Profile } from "./types.js";

export const DEFAULT_PROFILE_HYSTERESIS: ExecutionProfileHysteresisBounds = {
  cheapMediumLow: 0.045,
  cheapMediumHigh: 0.055,
  mediumExpensiveLow: 0.325,
  mediumExpensiveHigh: 0.375,
};

export interface ResolveProfileInput {
  currentProfile: Profile | null;
  avgEntry: number;
  config: ExecutionProfileHysteresisBounds;
}

export interface ResolveProfileResult {
  profile: Profile | null;
  changed: boolean;
  reason: "first_assignment" | "hysteresis_stay" | "hysteresis_transition" | "invalid_avg_entry";
}

export function resolveProfile(input: ResolveProfileInput): ResolveProfileResult {
  const { currentProfile, avgEntry, config } = input;
  if (!Number.isFinite(avgEntry) || avgEntry <= 0) {
    return { profile: null, changed: false, reason: "invalid_avg_entry" };
  }
  if (currentProfile == null) {
    return {
      profile: directProfile(avgEntry, config),
      changed: true,
      reason: "first_assignment",
    };
  }

  const profile = resolveWithHysteresis(currentProfile, avgEntry, config);
  return {
    profile,
    changed: profile !== currentProfile,
    reason: profile === currentProfile ? "hysteresis_stay" : "hysteresis_transition",
  };
}

function directProfile(avgEntry: number, config: ExecutionProfileHysteresisBounds): Profile {
  const cheapMediumBoundary = (config.cheapMediumLow + config.cheapMediumHigh) / 2;
  const mediumExpensiveBoundary = (config.mediumExpensiveLow + config.mediumExpensiveHigh) / 2;
  if (avgEntry < cheapMediumBoundary) return "cheap";
  if (avgEntry < mediumExpensiveBoundary) return "medium";
  return "expensive";
}

function resolveWithHysteresis(
  currentProfile: Profile,
  avgEntry: number,
  config: ExecutionProfileHysteresisBounds,
): Profile {
  if (currentProfile === "cheap") {
    return avgEntry < config.cheapMediumHigh ? "cheap" : directProfile(avgEntry, config);
  }
  if (currentProfile === "medium") {
    if (avgEntry < config.cheapMediumLow) return "cheap";
    if (avgEntry < config.mediumExpensiveHigh) return "medium";
    return "expensive";
  }
  return avgEntry >= config.mediumExpensiveLow ? "expensive" : directProfile(avgEntry, config);
}
