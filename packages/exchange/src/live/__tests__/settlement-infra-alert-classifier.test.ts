import { describe, expect, it } from "vitest";
import { classifySettlementInfraAlert } from "../exchange-gateway.js";

// The exact relayer 400 envelope observed in prod for a zero-balance redeem.
// The outer `"error":"request error"` previously matched the transport-error
// branch and mislabeled this benign skip as POLYMARKET_RELAYER_UNAVAILABLE.
const ZERO_BALANCE_ENVELOPE =
  '{"error":"request error","status":400,"statusText":"Bad Request",' +
  '"data":{"error":"PRECHECK_SKIPPED: redeem skipped: zero position balance"}}';

describe("classifySettlementInfraAlert", () => {
  it("does NOT classify a zero-position-balance precheck skip as relayer unavailable", () => {
    expect(classifySettlementInfraAlert(new Error(ZERO_BALANCE_ENVELOPE))).toBeNull();
  });

  it("does NOT suppress a non-zero-balance PRECHECK_SKIPPED — it stays a real alert", () => {
    // A PRECHECK_SKIPPED for any reason other than zero balance must NOT be hidden.
    // It arrives in the same "request error" envelope, so it classifies as a real
    // relayer/request alert rather than being silently dropped.
    const envelope =
      '{"error":"request error","status":400,"data":{"error":"PRECHECK_SKIPPED: nothing to do"}}';
    const alert = classifySettlementInfraAlert(new Error(envelope));
    expect(alert).not.toBeNull();
    expect(alert?.code).toBe("POLYMARKET_RELAYER_UNAVAILABLE");
  });

  it("still classifies a genuine relayer connection failure as relayer unavailable", () => {
    const alert = classifySettlementInfraAlert(new Error("connection error: ECONNRESET"));
    expect(alert?.code).toBe("POLYMARKET_RELAYER_UNAVAILABLE");
    expect(alert?.severity).toBe("warning");
    expect(alert?.source).toBe("polymarket-relayer");
  });

  it("still classifies a generic relayer request error (no precheck) as relayer unavailable", () => {
    const alert = classifySettlementInfraAlert(new Error("request error: socket hang up"));
    expect(alert?.code).toBe("POLYMARKET_RELAYER_UNAVAILABLE");
  });

  it("classifies a 429 / rate-limit error as Polygon RPC rate limited", () => {
    expect(classifySettlementInfraAlert(new Error("429 Too Many Requests"))?.code).toBe(
      "POLYGON_RPC_RATE_LIMITED",
    );
    expect(
      classifySettlementInfraAlert(new Error("provider exceeded its compute units per second"))
        ?.code,
    ).toBe("POLYGON_RPC_RATE_LIMITED");
  });

  it("classifies a 503 / no-healthy-upstream error as Polygon RPC unavailable", () => {
    expect(classifySettlementInfraAlert(new Error("503 no healthy upstream"))?.code).toBe(
      "POLYGON_RPC_UNAVAILABLE",
    );
  });

  it("classifies a 401 / invalid-authorization error as relayer auth failure", () => {
    const alert = classifySettlementInfraAlert(new Error("401 invalid authorization"));
    expect(alert?.code).toBe("POLYMARKET_RELAYER_AUTH");
    expect(alert?.severity).toBe("error");
  });

  it("does not misclassify a duplicate-nonce error as relayer unavailable", () => {
    // A duplicate / already-known nonce means the tx was already broadcast (benign,
    // will confirm). It must not surface as a relayer outage.
    expect(classifySettlementInfraAlert(new Error("nonce too low"))).toBeNull();
    expect(classifySettlementInfraAlert(new Error("duplicate nonce; already known"))).toBeNull();
  });

  it("does not misclassify duplicate in-flight relayer submit envelopes as unavailable", () => {
    const envelope =
      '{"error":"request error","status":409,"statusText":"Conflict",' +
      '"data":{"error":"duplicate in-flight transaction for this nonce"}}';
    const alert = classifySettlementInfraAlert(new Error(envelope));
    expect(alert?.code).toBe("POLYMARKET_RELAYER_DUPLICATE_IN_FLIGHT");
    expect(alert?.message).not.toContain("unavailable");
  });

  it("returns null for unrecognized / benign errors", () => {
    expect(classifySettlementInfraAlert(new Error("something unexpected"))).toBeNull();
    expect(classifySettlementInfraAlert(null)).toBeNull();
  });
});
