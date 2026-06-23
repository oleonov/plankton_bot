import { describe, it, expect } from "vitest";
import { buildAlchemyPolygonUrl, resolvePolygonRpcConfig } from "../polygon-rpc.js";

const ALCHEMY = "https://polygon-mainnet.g.alchemy.com/v2";
const DRPC = "https://polygon.drpc.org";

describe("buildAlchemyPolygonUrl", () => {
  it("builds the Polygon mainnet v2 URL from a key", () => {
    expect(buildAlchemyPolygonUrl("KEY1")).toBe(`${ALCHEMY}/KEY1`);
  });
});

describe("resolvePolygonRpcConfig", () => {
  it("maps Alchemy keys to primary URLs and keeps fallback separate", () => {
    const r = resolvePolygonRpcConfig({
      alchemyPolygonKeys: ["KEY1", "KEY2", "KEY3"],
      polygonRpcFallbackUrl: DRPC,
    });
    expect(r.primaryUrls).toEqual([`${ALCHEMY}/KEY1`, `${ALCHEMY}/KEY2`, `${ALCHEMY}/KEY3`]);
    expect(r.fallbackUrls).toEqual([DRPC]);
    expect(r.issues).toEqual([]);
  });

  it("dedups keys and preserves order", () => {
    const r = resolvePolygonRpcConfig({ alchemyPolygonKeys: ["KEY1", "KEY1", "KEY2"] });
    expect(r.primaryUrls).toEqual([`${ALCHEMY}/KEY1`, `${ALCHEMY}/KEY2`]);
    expect(r.fallbackUrls).toEqual([]);
  });

  it("uses Alchemy keys as source of truth and reports ignored legacy URLs without keys", () => {
    const r = resolvePolygonRpcConfig({
      alchemyPolygonKeys: ["SECRET_KEY_1", "SECRET_KEY_2"],
      polygonRpcUrl: `${ALCHEMY}/SECRET_KEY_1`,
      polygonRpcUrls: [`${ALCHEMY}/SECRET_KEY_1`, `${ALCHEMY}/LEGACY_KEY`],
      polygonRpcFallbackUrl: DRPC,
    });
    expect(r.primaryUrls).toEqual([`${ALCHEMY}/SECRET_KEY_1`, `${ALCHEMY}/SECRET_KEY_2`]);
    expect(r.fallbackUrls).toEqual([DRPC]);
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: "legacy_polygon_rpc_urls_ignored",
        sourceOfTruth: "ALCHEMY_POLYGON_KEYS",
        ignoredSources: ["POLYGON_RPC_URL", "POLYGON_RPC_URLS"],
      }),
    ]);
    expect(JSON.stringify(r.issues)).not.toContain("SECRET_KEY");
    expect(JSON.stringify(r.issues)).not.toContain("LEGACY_KEY");
  });

  it("reports only POLYGON_RPC_URL ignored when keys are mixed with the legacy single URL", () => {
    const r = resolvePolygonRpcConfig({
      alchemyPolygonKeys: ["SECRET_KEY_1", "SECRET_KEY_2"],
      polygonRpcUrl: `${ALCHEMY}/LEGACY_SINGLE_KEY`,
    });
    expect(r.primaryUrls).toEqual([`${ALCHEMY}/SECRET_KEY_1`, `${ALCHEMY}/SECRET_KEY_2`]);
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: "legacy_polygon_rpc_urls_ignored",
        ignoredSources: ["POLYGON_RPC_URL"],
      }),
    ]);
    expect(JSON.stringify(r.issues)).not.toContain("SECRET_KEY");
    expect(JSON.stringify(r.issues)).not.toContain("LEGACY_SINGLE_KEY");
  });

  it("reports only POLYGON_RPC_URLS ignored when keys are mixed with the legacy URL list", () => {
    const r = resolvePolygonRpcConfig({
      alchemyPolygonKeys: ["SECRET_KEY_1", "SECRET_KEY_2"],
      polygonRpcUrls: [`${ALCHEMY}/LEGACY_LIST_KEY_1`, `${ALCHEMY}/LEGACY_LIST_KEY_2`],
    });
    expect(r.primaryUrls).toEqual([`${ALCHEMY}/SECRET_KEY_1`, `${ALCHEMY}/SECRET_KEY_2`]);
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: "legacy_polygon_rpc_urls_ignored",
        ignoredSources: ["POLYGON_RPC_URLS"],
      }),
    ]);
    expect(JSON.stringify(r.issues)).not.toContain("SECRET_KEY");
    expect(JSON.stringify(r.issues)).not.toContain("LEGACY_LIST_KEY");
  });

  it("backward-compat: legacy POLYGON_RPC_URLS populate primary, fallback stays separate", () => {
    const r = resolvePolygonRpcConfig({
      polygonRpcUrls: ["https://a.example/1", "https://b.example/2"],
      polygonRpcFallbackUrl: DRPC,
    });
    expect(r.primaryUrls).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(r.fallbackUrls).toEqual([DRPC]);
  });

  it("legacy precedence: POLYGON_RPC_URLS wins, POLYGON_RPC_URL ignored", () => {
    const r = resolvePolygonRpcConfig({
      polygonRpcUrls: ["https://list.example/1"],
      polygonRpcUrl: "https://single.example/1",
    });
    expect(r.primaryUrls).toEqual(["https://list.example/1"]);
  });

  it("falls back to the single legacy URL when no list/keys", () => {
    const r = resolvePolygonRpcConfig({ polygonRpcUrl: "https://single.example/1" });
    expect(r.primaryUrls).toEqual(["https://single.example/1"]);
  });

  it("empty input → public polygon-rpc.com in primary, empty fallback", () => {
    const r = resolvePolygonRpcConfig({});
    expect(r.primaryUrls).toEqual(["https://polygon-rpc.com"]);
    expect(r.fallbackUrls).toEqual([]);
  });

  it("drops a fallback that duplicates a primary", () => {
    const r = resolvePolygonRpcConfig({
      polygonRpcUrls: [DRPC],
      polygonRpcFallbackUrl: DRPC,
    });
    expect(r.primaryUrls).toEqual([DRPC]);
    expect(r.fallbackUrls).toEqual([]);
  });

  it("drops fallback when it duplicates a generated Alchemy URL", () => {
    const r = resolvePolygonRpcConfig({
      alchemyPolygonKeys: ["KEY1"],
      polygonRpcFallbackUrl: `${ALCHEMY}/KEY1`,
    });
    expect(r.primaryUrls).toEqual([`${ALCHEMY}/KEY1`]);
    expect(r.fallbackUrls).toEqual([]);
  });
});
