import { describe, it, expect, vi } from "vitest";
import { createPolymarketClient } from "../polymarket-client-factory.js";

const BUILDER_CODE = `0x${"a".repeat(64)}`;

const baseConfig = {
  polyApiKey: "poly-key",
  polyApiSecret: "poly-secret",
  polyPassphrase: "poly-passphrase",
  polyBuilderApiKey: "builder-key-from-env",
  polyBuilderSecret: "builder-secret-from-env",
  polyBuilderPassphrase: "builder-passphrase-from-env",
  polyBuilderCode: BUILDER_CODE,
  polyPrivateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  polymarketRelayerUrl: "https://relayer-v2.polymarket.com",
  polygonRpcUrl: "https://polygon-rpc.com",
};

describe("createPolymarketClient", () => {
  it("creates a paper-mode client without signer creds, including builderCode attribution", async () => {
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
    expect(result.userWsAuth).toBeNull();
    expect(createClobClient).toHaveBeenCalledWith({
      host: "https://clob.polymarket.com",
      chain: 137,
      builderConfig: { builderCode: BUILDER_CODE },
    });
  });

  it("omits builderConfig when polyBuilderCode is not configured", async () => {
    const createClobClient = vi.fn().mockReturnValue({ mode: "paper-client" });

    await createPolymarketClient(
      {
        runtimeMode: "paper",
        config: { ...baseConfig, polyBuilderCode: undefined },
      },
      {
        createClobClient,
        createWallet: vi.fn(),
      },
    );

    expect(createClobClient).toHaveBeenCalledWith({
      host: "https://clob.polymarket.com",
      chain: 137,
    });
  });

  it("creates an EOA live-lite client with signer, API creds and builderCode", async () => {
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
    expect(result.userWsAuth).toEqual({
      apiKey: "poly-key",
      secret: "poly-secret",
      passphrase: "poly-passphrase",
    });
    expect(createWallet).toHaveBeenCalledWith(baseConfig.polyPrivateKey);
    expect(createClobClient).toHaveBeenCalledWith({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer,
      creds: {
        key: "poly-key",
        secret: "poly-secret",
        passphrase: "poly-passphrase",
      },
      builderConfig: { builderCode: BUILDER_CODE },
    });
  });

  it("creates a relayer live-lite client with signatureType, funder, builderCode and relayer settlement", async () => {
    const signer = { kind: "wallet", address: "0x2222222222222222222222222222222222222222" };
    const relayerBuilderConfig = { kind: "relayer-builder-config" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "relayer-client" });
    const createBuilderConfig = vi.fn().mockReturnValue(relayerBuilderConfig);
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
    expect(result.userWsAuth).toEqual({
      apiKey: "poly-key",
      secret: "poly-secret",
      passphrase: "poly-passphrase",
    });
    expect(createBuilderConfig).toHaveBeenCalledWith({
      localBuilderCreds: {
        key: "builder-key",
        secret: "builder-secret",
        passphrase: "builder-passphrase",
      },
    });
    expect(createClobClient).toHaveBeenCalledWith({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer,
      creds: {
        key: "poly-key",
        secret: "poly-secret",
        passphrase: "poly-passphrase",
      },
      signatureType: 1,
      funderAddress: "0x1111111111111111111111111111111111111111",
      builderConfig: { builderCode: BUILDER_CODE },
    });
    expect(createSettlementClient).toHaveBeenCalledWith({
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      privateKey: baseConfig.polyPrivateKey,
      rpcUrl: "https://polygon-rpc.com",
      builderConfig: relayerBuilderConfig,
      walletType: "proxy",
    });
  });

  it("falls back to POLY_BUILDER_* HMAC creds for relayer builder auth when relayer_json has no builder", async () => {
    const signer = { kind: "wallet", address: "0x2222222222222222222222222222222222222222" };
    const relayerBuilderConfig = { kind: "relayer-builder-config" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "relayer-client" });
    const createBuilderConfig = vi.fn().mockReturnValue(relayerBuilderConfig);
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
    expect(createClobClient).toHaveBeenCalledWith({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer,
      creds: {
        key: "poly-key",
        secret: "poly-secret",
        passphrase: "poly-passphrase",
      },
      signatureType: 1,
      funderAddress: "0x1111111111111111111111111111111111111111",
      builderConfig: { builderCode: BUILDER_CODE },
    });
    expect(createSettlementClient).toHaveBeenCalledWith({
      relayerUrl: "https://relayer-v2.polymarket.com",
      chainId: 137,
      privateKey: baseConfig.polyPrivateKey,
      rpcUrl: "https://polygon-rpc.com",
      builderConfig: relayerBuilderConfig,
      walletType: "proxy",
    });
    expect(settlementClient).toBeDefined();
  });

  it("passes Polygon RPC rotation URLs to the relayer settlement client", async () => {
    const signer = { kind: "wallet", address: "0x2222222222222222222222222222222222222222" };
    const relayerBuilderConfig = { kind: "relayer-builder-config" };
    const createWallet = vi.fn().mockReturnValue(signer);
    const createClobClient = vi.fn().mockReturnValue({ mode: "relayer-client" });
    const createBuilderConfig = vi.fn().mockReturnValue(relayerBuilderConfig);
    const settlementClient = { kind: "settlement-client" };
    const createSettlementClient = vi.fn().mockResolvedValue(settlementClient);

    await createPolymarketClient(
      {
        runtimeMode: "live-lite",
        config: {
          ...baseConfig,
          polygonRpcUrls: ["https://rpc-one.local", "https://rpc-two.local"],
          polygonRpcFallbackUrl: "https://polygon.drpc.org",
        },
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

    expect(createSettlementClient).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: "https://polygon-rpc.com",
        rpcUrls: ["https://rpc-one.local", "https://rpc-two.local"],
        rpcFallbackUrl: "https://polygon.drpc.org",
      }),
    );
  });

  it("throws when relayer mode has neither relayer_json.builder nor POLY_BUILDER_* HMAC creds", async () => {
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
