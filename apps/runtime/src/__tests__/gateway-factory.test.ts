import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGateways } from "../gateway-factory.js";
import {
  SimulationExchangeGateway,
  SimulationMarketDataGateway,
  createCollateralResolver,
} from "@krabs/exchange";

vi.mock("@krabs/exchange", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@krabs/exchange")>();
  return {
    ...actual,
    createCollateralResolver: vi.fn(actual.createCollateralResolver),
  };
});

describe("createGateways", () => {
  beforeEach(() => {
    vi.mocked(createCollateralResolver).mockClear();
  });

  it("live-lite mode returns live market-data and live exchange gateways", () => {
    const mockClient = { getOk: async () => "OK" };
    const result = createGateways({
      runtimeMode: "live-lite",
      polyClient: mockClient,
    });

    expect(result.marketDataGateway).not.toBeInstanceOf(SimulationMarketDataGateway);
    expect(result.exchangeGateway).not.toBeInstanceOf(SimulationExchangeGateway);
    expect(result.modeLabel).toBe("live-lite");
    expect(result.marketDataSource).toBe("live");
    expect(result.executionMode).toBe("live");
  });

  it("live-lite mode passes user websocket auth through to the live exchange gateway", () => {
    const mockClient = { getOk: async () => "OK" };
    const result = createGateways({
      runtimeMode: "live-lite",
      polyClient: mockClient,
      userWsAuth: {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase",
      },
    });

    expect(result.exchangeGateway.createUserEventStream).toBeTypeOf("function");
  });

  it("live-lite mode without polyClient throws", () => {
    expect(() => createGateways({ runtimeMode: "live-lite" })).toThrow(
      "polyClient is required for live-lite mode",
    );
  });

  it("includes polygonRpcFallbackUrl in collateral resolver rotation", () => {
    const mockClient = { getOk: async () => "OK" };
    createGateways({
      runtimeMode: "live-lite",
      polyClient: mockClient,
      polygonRpcUrl: "https://polygon-mainnet.g.alchemy.com/v2/primary",
      polygonRpcUrls: [
        "https://polygon-mainnet.g.alchemy.com/v2/primary",
        "https://polygon-mainnet.g.alchemy.com/v2/secondary",
      ],
      polygonRpcFallbackUrl: "https://polygon.drpc.org",
    });

    expect(createCollateralResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        rotator: expect.objectContaining({ ethCall: expect.any(Function) }),
      }),
    );
  });

  it("builds a live-lite gateway when Alchemy keys are provided", () => {
    const result = createGateways({
      runtimeMode: "live-lite",
      polyClient: { getOk: async () => "OK" },
      settlementClient: {},
      traderAddress: "0x1111111111111111111111111111111111111111",
      alchemyPolygonKeys: ["KEY1", "KEY2", "KEY3"],
      polygonRpcFallbackUrl: "https://polygon.drpc.org",
    });
    expect(result.modeLabel).toBe("live-lite");
    expect(result.executionMode).toBe("live");
    expect(createCollateralResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        rotator: expect.objectContaining({ ethCall: expect.any(Function) }),
      }),
    );
  });

  it("builds a live-lite gateway from legacy URLs when no keys", () => {
    const result = createGateways({
      runtimeMode: "live-lite",
      polyClient: { getOk: async () => "OK" },
      settlementClient: {},
      traderAddress: "0x1111111111111111111111111111111111111111",
      polygonRpcUrls: ["https://a.example/1", "https://b.example/2"],
    });
    expect(result.modeLabel).toBe("live-lite");
  });

  it.each(["paper", "simulation", "unknown"])("rejects unsupported mode %s", (runtimeMode) => {
    expect(() =>
      createGateways({
        runtimeMode: runtimeMode as "live-lite",
        polyClient: { getOk: async () => "OK" },
      }),
    ).toThrow(/UNSUPPORTED_RUNTIME_PROFILE|unsupported runtimeMode/);
  });

  it("does not fall through to live gateways for unknown modes", () => {
    expect(() =>
      createGateways({
        runtimeMode: "unknown" as "live-lite",
        polyClient: { getOk: async () => "OK" },
      }),
    ).toThrow();
    expect(createCollateralResolver).not.toHaveBeenCalled();
  });

  it("still supports simulation gateway classes as direct test doubles", () => {
    expect(new SimulationMarketDataGateway()).toBeInstanceOf(SimulationMarketDataGateway);
    expect(new SimulationExchangeGateway()).toBeInstanceOf(SimulationExchangeGateway);
  });
});
