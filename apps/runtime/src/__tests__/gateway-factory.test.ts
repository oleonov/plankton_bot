import { beforeEach, describe, it, expect, vi } from "vitest";
import { createGateways } from "../gateway-factory.js";
import {
  SimulationMarketDataGateway,
  SimulationExchangeGateway,
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

  it("simulation mode returns both simulation gateways", () => {
    const result = createGateways({ runtimeMode: "simulation" });
    expect(result.marketDataGateway).toBeInstanceOf(SimulationMarketDataGateway);
    expect(result.exchangeGateway).toBeInstanceOf(SimulationExchangeGateway);
    expect(result.modeLabel).toBe("simulation");
    expect(result.marketDataSource).toBe("simulation");
    expect(result.executionMode).toBe("simulation");
  });

  it("paper mode returns live market-data + simulation exchange", () => {
    const mockClient = { getOk: async () => "OK" };
    const result = createGateways({
      runtimeMode: "paper",
      polyClient: mockClient,
    });
    expect(result.marketDataGateway).not.toBeInstanceOf(SimulationMarketDataGateway);
    expect(result.exchangeGateway).toBeInstanceOf(SimulationExchangeGateway);
    expect(result.modeLabel).toBe("paper");
    expect(result.marketDataSource).toBe("live");
    expect(result.executionMode).toBe("simulation");
  });

  it("paper mode without polyClient throws", () => {
    expect(() => createGateways({ runtimeMode: "paper" })).toThrow(
      "polyClient is required for paper mode",
    );
  });

  it("live-lite mode returns live market-data + live exchange", () => {
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

  it("simulation mode passes initialBalanceUsdc to exchange gateway", async () => {
    const result = createGateways({ runtimeMode: "simulation", initialBalanceUsdc: 250 });
    expect(result.exchangeGateway).toBeInstanceOf(SimulationExchangeGateway);
    const balances = await result.exchangeGateway.getBalances();
    expect(balances[0]!.available).toBe(250);
  });

  it("paper mode passes initialBalanceUsdc to exchange gateway", async () => {
    const mockClient = { getOk: async () => "OK" };
    const result = createGateways({
      runtimeMode: "paper",
      polyClient: mockClient,
      initialBalanceUsdc: 100,
    });
    expect(result.exchangeGateway).toBeInstanceOf(SimulationExchangeGateway);
    const balances = await result.exchangeGateway.getBalances();
    expect(balances[0]!.available).toBe(100);
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
});
