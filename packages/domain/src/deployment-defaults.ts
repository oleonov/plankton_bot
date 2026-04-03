import { DeploymentStage, ProfileId } from "./enums.js";

interface ResolveFamilyDeploymentSeedInput {
  profile: import("./enums.js").ProfileId;
  sourceType?: string | null;
  currentProfile?: import("./enums.js").ProfileId | null;
}

interface FamilyDeploymentSeed {
  enabled: boolean;
  deploymentStage: import("./enums.js").DeploymentStage;
}

export function resolveFamilyDeploymentSeed({
  profile,
  sourceType,
  currentProfile,
}: ResolveFamilyDeploymentSeedInput): FamilyDeploymentSeed {
  if (sourceType === "yaml_import") {
    return profile === ProfileId.LiveLite
      ? { enabled: true, deploymentStage: DeploymentStage.LiveProbe }
      : { enabled: true, deploymentStage: DeploymentStage.Disabled };
  }

  if (profile === ProfileId.LiveLite && currentProfile === ProfileId.LiveLite) {
    return { enabled: true, deploymentStage: DeploymentStage.LiveProbe };
  }

  return {
    enabled: profile === ProfileId.Simulation || profile === ProfileId.Paper,
    deploymentStage: DeploymentStage.Disabled,
  };
}
