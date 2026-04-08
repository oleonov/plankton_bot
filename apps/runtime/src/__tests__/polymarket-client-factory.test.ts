import { describe, it, expect, vi } from "vitest";
import { createPolymarketClient } from "../polymarket-client-factory.js";

const baseConfig = {
  polyApiKey: "poly-key",
  polyApiSecret: "poly-secret",
  polyPassphrase: "poly-passphrase",
  polyBuilderApiKey: "builder-key-from-env",
  polyBuilderSecret: "builder-secret-from-env",
  polyBuilderPassphrase: "builder-passphrase-from-env",
  polyPrivateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  polymarketRelayerUrl: "https://relayer-v2.polymarket.com",
  polygonRpcUrl: "https://polygon-rpc.com",
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
    expect(result.settlementClient).toBeNull();
    expect(result.relayerConfig).toBeNull();
    expect(createClobClient).toHaveBeenCalledWith("https://clob.polymarket.com", 137);
  });

  it("creates an EOA live-lite client with signer and API creds", async () => {
    const signer = { kind: "wallet", address: "0x2222222222222222222222222222222222222222" };
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
    expect(result.settlementClient).toBeNull();
    expect(result.relayerConfig).toBeNull();
    expect(result.traderAddress).toBe("0x2222222222222222222222222222222222222222");
    expect(createWallet).toHaveBeenCalledWith(baseConfig.polyPrivateKey);
    expect(createClobClient).toHaveBeenCalledWith("https://clob.polymarket.com", 137, signer, {
      key: "poly-key",
      secret: "poly-secret",
      passphrase: "poly-passphrase",
    });
  });

  it("creates a relayer live-lite client with signatureType, funder and builder config", async () => {
    const signer = { kind: "wallet", address: "0x2222222222222222222222222222222222222222" };
    const builderConfig = { kind: "builder-config" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "relayer-client" });
    const createBuilderConfig = vi.fn().mockReturnValue(builderConfig);
    const settlementClient = { kind: "settlement-client" };
    const createSettlementClient = vi.fn().mockResolvedValue(settlementClient);

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
        createSettlementClient,
      },
    );

    expect(result.settlementClient).toBe(settlementClient);
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
    expect(result.traderAddress).toBe("0x1111111111111111111111111111111111111111");
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
    expect(createSettlementClient).toHaveBeenCalledWith({
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      privateKey: baseConfig.polyPrivateKey,
      rpcUrl: "https://polygon-rpc.com",
      builderConfig,
      walletType: "proxy",
    });
  });

  it("falls back to POLY_BUILDER_* creds for relayer builder auth when relayer_json has no builder", async () => {
    const signer = { kind: "wallet", address: "0x2222222222222222222222222222222222222222" };
    const builderConfig = { kind: "builder-config" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "relayer-client" });
    const createBuilderConfig = vi.fn().mockReturnValue(builderConfig);
    const settlementClient = { kind: "settlement-client" };
    const createSettlementClient = vi.fn().mockResolvedValue(settlementClient);

    await createPolymarketClient(
      {
        runtimeMode: "live-lite",
        config: baseConfig,
        walletMode: "relayer",
        relayerJson: JSON.stringify({
          walletType: "proxy",
          funderAddress: "0x1111111111111111111111111111111111111111",
        }),
      },
      {
        createClobClient,
        createWallet,
        createBuilderConfig,
        createSettlementClient,
      },
    );

    expect(createBuilderConfig).toHaveBeenCalledWith({
      localBuilderCreds: {
        key: "builder-key-from-env",
        secret: "builder-secret-from-env",
        passphrase: "builder-passphrase-from-env",
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
    expect(createSettlementClient).toHaveBeenCalledWith({
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      privateKey: baseConfig.polyPrivateKey,
      rpcUrl: "https://polygon-rpc.com",
      builderConfig,
      walletType: "proxy",
    });
    expect(settlementClient).toBeDefined();
  });

  it("throws when relayer mode has neither relayer_json.builder nor POLY_BUILDER_* creds", async () => {
    await expect(
      createPolymarketClient(
        {
          runtimeMode: "live-lite",
          config: {
            ...baseConfig,
            polyBuilderApiKey: undefined,
            polyBuilderSecret: undefined,
            polyBuilderPassphrase: undefined,
          },
          walletMode: "relayer",
          relayerJson: JSON.stringify({
            walletType: "proxy",
            funderAddress: "0x1111111111111111111111111111111111111111",
          }),
        },
        {
          createClobClient: vi.fn(),
          createWallet: vi.fn().mockReturnValue({ kind: "wallet" }),
        },
      ),
    ).rejects.toThrow("builder credentials are required for relayer mode");
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
