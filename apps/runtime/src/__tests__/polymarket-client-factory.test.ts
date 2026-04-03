import { describe, it, expect, vi } from "vitest";
import { createPolymarketClient } from "../polymarket-client-factory.js";

const baseConfig = {
  polyApiKey: "poly-key",
  polyApiSecret: "poly-secret",
  polyPassphrase: "poly-passphrase",
  polyPrivateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("createPolymarketClient", () => {
  it("creates a paper-mode client without signer creds", async () => {
    const createClobClient = vi.fn().mockReturnValue({ mode: "paper-client" });

    const result = await createPolymarketClient(
      {
        runtimeMode: "paper",
        config: baseConfig,
      },
      {
        createClobClient,
        createWallet: vi.fn(),
      },
    );

    expect(result.client).toEqual({ mode: "paper-client" });
    expect(result.relayerConfig).toBeNull();
    expect(createClobClient).toHaveBeenCalledWith("https://clob.polymarket.com", 137);
  });

  it("creates an EOA live-lite client with signer and API creds", async () => {
    const signer = { kind: "wallet" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "eoa-client" });

    const result = await createPolymarketClient(
      {
        runtimeMode: "live-lite",
        config: baseConfig,
        walletMode: "eoa",
      },
      {
        createClobClient,
        createWallet,
      },
    );

    expect(result.client).toEqual({ mode: "eoa-client" });
    expect(result.relayerConfig).toBeNull();
    expect(createWallet).toHaveBeenCalledWith(baseConfig.polyPrivateKey);
    expect(createClobClient).toHaveBeenCalledWith("https://clob.polymarket.com", 137, signer, {
      key: "poly-key",
      secret: "poly-secret",
      passphrase: "poly-passphrase",
    });
  });

  it("creates a relayer live-lite client with signatureType, funder and builder config", async () => {
    const signer = { kind: "wallet" };
    const builderConfig = { kind: "builder-config" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "relayer-client" });
    const createBuilderConfig = vi.fn().mockReturnValue(builderConfig);

    const result = await createPolymarketClient(
      {
        runtimeMode: "live-lite",
        config: baseConfig,
        walletMode: "relayer",
        relayerJson: JSON.stringify({
          walletType: "proxy",
          funderAddress: "0x1111111111111111111111111111111111111111",
          builder: {
            mode: "local",
            key: "builder-key",
            secret: "builder-secret",
            passphrase: "builder-passphrase",
          },
        }),
      },
      {
        createClobClient,
        createWallet,
        createBuilderConfig,
      },
    );

    expect(result.relayerConfig).toEqual({
      walletType: "proxy",
      funderAddress: "0x1111111111111111111111111111111111111111",
      builder: {
        mode: "local",
        key: "builder-key",
        secret: "builder-secret",
        passphrase: "builder-passphrase",
      },
    });
    expect(createBuilderConfig).toHaveBeenCalledWith({
      localBuilderCreds: {
        key: "builder-key",
        secret: "builder-secret",
        passphrase: "builder-passphrase",
      },
    });
    expect(createClobClient).toHaveBeenCalledWith(
      "https://clob.polymarket.com",
      137,
      signer,
      {
        key: "poly-key",
        secret: "poly-secret",
        passphrase: "poly-passphrase",
      },
      1,
      "0x1111111111111111111111111111111111111111",
      undefined,
      undefined,
      builderConfig,
    );
  });

  it("throws when relayer mode is configured with invalid relayer_json", async () => {
    await expect(
      createPolymarketClient(
        {
          runtimeMode: "live-lite",
          config: baseConfig,
          walletMode: "relayer",
          relayerJson: JSON.stringify({ walletType: "proxy" }),
        },
        {
          createClobClient: vi.fn(),
          createWallet: vi.fn().mockReturnValue({ kind: "wallet" }),
        },
      ),
    ).rejects.toThrow("relayer_json.funderAddress");
  });
});
