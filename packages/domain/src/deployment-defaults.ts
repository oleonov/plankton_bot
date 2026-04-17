import { ProfileId } from "./enums.js";

interface ResolveFamilyDeploymentSeedInput {
  profile: import("./enums.js").ProfileId;
  sourceType?: string | null;
  currentProfile?: import("./enums.js").ProfileId | null;
}

interface FamilyDeploymentSeed {
  enabled: boolean;
}

export function resolveFamilyDeploymentSeed({
  profile,
  sourceType,
  currentProfile,
}: ResolveFamilyDeploymentSeedInput): FamilyDeploymentSeed {
  if (sourceType === "yaml_import") {
    return { enabled: true };
  }

  if (profile === ProfileId.LiveLite && currentProfile === ProfileId.LiveLite) {
    return { enabled: true };
  }

  return {
    enabled: profile === ProfileId.Simulation || profile === ProfileId.Paper,
  };
}
