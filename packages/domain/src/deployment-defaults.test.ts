import { describe, expect, it } from "vitest";
import { DeploymentStage, ProfileId } from "./enums.js";
import { resolveFamilyDeploymentSeed } from "./deployment-defaults.js";

describe("resolveFamilyDeploymentSeed", () => {
  it("enables yaml-import families in live-lite by default", () => {
    expect(
      resolveFamilyDeploymentSeed({
        profile: ProfileId.LiveLite,
        sourceType: "yaml_import",
      }),
    ).toEqual({
      enabled: true,
      deploymentStage: DeploymentStage.LiveProbe,
    });
  });

  it("keeps discovery families live-lite disabled when current profile is not live-lite", () => {
    expect(
      resolveFamilyDeploymentSeed({
        profile: ProfileId.LiveLite,
        currentProfile: ProfileId.Paper,
      }),
    ).toEqual({
      enabled: false,
      deploymentStage: DeploymentStage.Disabled,
    });
  });

  it("enables discovery families in the current live-lite profile", () => {
    expect(
      resolveFamilyDeploymentSeed({
        profile: ProfileId.LiveLite,
        currentProfile: ProfileId.LiveLite,
      }),
    ).toEqual({
      enabled: true,
      deploymentStage: DeploymentStage.LiveProbe,
    });
  });
});
