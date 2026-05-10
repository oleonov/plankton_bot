import { describe, it, expect } from "vitest";
import { createGateways } from "../gateway-factory.js";
import { SimulationMarketDataGateway, SimulationExchangeGateway } from "@krabs/exchange";

describe("createGateways", () => {
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
});
