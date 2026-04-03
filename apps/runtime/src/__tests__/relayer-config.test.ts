import { describe, it, expect } from "vitest";
import {
  parseRelayerConfigJson,
  resolveRelayerSignatureType,
} from "../relayer-config.js";

describe("parseRelayerConfigJson", () => {
  it("parses proxy relayer config with local builder creds", () => {
    const result = parseRelayerConfigJson(
      JSON.stringify({
        walletType: "proxy",
        funderAddress: "0x1111111111111111111111111111111111111111",
        builder: {
          mode: "local",
          key: "builder-key",
          secret: "builder-secret",
          passphrase: "builder-passphrase",
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      walletType: "proxy",
      funderAddress: "0x1111111111111111111111111111111111111111",
      builder: {
        mode: "local",
        key: "builder-key",
        secret: "builder-secret",
        passphrase: "builder-passphrase",
      },
    });
  });

  it("parses gnosis-safe relayer config from signatureType with remote builder config", () => {
    const result = parseRelayerConfigJson(
      JSON.stringify({
        signatureType: 2,
        funderAddress: "0x2222222222222222222222222222222222222222",
        builder: {
          mode: "remote",
          url: "https://builder.internal/sign",
          token: "bearer-token",
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value?.walletType).toBe("gnosis-safe");
    expect(result.value?.builder).toEqual({
      mode: "remote",
      url: "https://builder.internal/sign",
      token: "bearer-token",
    });
  });

  it("returns structured errors for invalid config", () => {
    const result = parseRelayerConfigJson(
      JSON.stringify({
        walletType: "invalid",
        funderAddress: "not-an-address",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("relayer_json.walletType must be 'proxy' or 'gnosis-safe'");
    expect(result.errors).toContain(
      "relayer_json.funderAddress must be a 0x-prefixed 20-byte hex address",
    );
  });

  it("requires relayer_json to be valid JSON", () => {
    const result = parseRelayerConfigJson("{broken");
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["relayer_json must be valid JSON"]);
  });
});

describe("resolveRelayerSignatureType", () => {
  it("maps proxy to signature type 1 and gnosis-safe to 2", () => {
    expect(
      resolveRelayerSignatureType({
        walletType: "proxy",
        funderAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).toBe(1);
    expect(
      resolveRelayerSignatureType({
        walletType: "gnosis-safe",
        funderAddress: "0x2222222222222222222222222222222222222222",
      }),
    ).toBe(2);
  });
});
