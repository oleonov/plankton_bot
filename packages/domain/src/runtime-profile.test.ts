import { describe, expect, it } from "vitest";
import {
  assertSupportedRuntimeProfile,
  isSupportedRuntimeProfile,
  SUPPORTED_RUNTIME_PROFILE,
} from "./enums.js";

describe("runtime profile support guard", () => {
  it("accepts live-lite as the only supported runtime profile", () => {
    expect(SUPPORTED_RUNTIME_PROFILE).toBe("live-lite");
    expect(isSupportedRuntimeProfile("live-lite")).toBe(true);
    expect(() => assertSupportedRuntimeProfile("live-lite")).not.toThrow();
  });

  it.each(["paper", "simulation", "bogus", null, undefined])(
    "rejects unsupported runtime profile %s",
    (profile) => {
      expect(isSupportedRuntimeProfile(profile)).toBe(false);
      expect(() => assertSupportedRuntimeProfile(profile)).toThrow(
        /UNSUPPORTED_RUNTIME_PROFILE.*live-lite/,
      );
    },
  );
});
