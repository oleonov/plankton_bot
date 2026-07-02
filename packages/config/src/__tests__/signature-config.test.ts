import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadEnv } from "../env.js";

describe("signature config", () => {
  it("defaults are applied", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "krabs-signature-config-test-"));
    const envPath = path.join(tempDir, "empty.env");
    writeFileSync(envPath, "");

    try {
      const c = loadEnv(envPath);
      expect(c.marketDataMaxTrackedTokens).toBe(2000);
      expect(c.marketDataSignatureReserve).toBe(300);
      expect(c.signatureMinLiquidity).toBe(500);
      expect(c.signatureMinMid).toBe(0.01);
      expect(c.signatureMaxMid).toBe(0.3);
      expect(c.signatureMinRemainingDays).toBe(14);
      expect(c.signatureMinVol24h).toBe(50);
      expect(c.signatureMinTick).toBe(0.001);
      expect(c.signatureFeatureTtlMs).toBe(86_400_000);
      expect(c.marketDataSignatureTierMode).toBe("shadow");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
