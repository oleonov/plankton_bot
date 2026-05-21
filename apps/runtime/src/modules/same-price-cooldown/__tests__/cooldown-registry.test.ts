import { describe, expect, it, vi } from "vitest";
import { createTokenId } from "@krabs/domain";
import { CooldownRegistry } from "../cooldown-registry.js";

const TOKEN = createTokenId("token-1");
const NOW = Date.parse("2026-05-21T00:00:00.000Z");

describe("CooldownRegistry", () => {
  it("suppresses active SELL cooldowns for the same token and price only", () => {
    const registry = new CooldownRegistry(logger() as never);
    registry.upsert(
      {
        tokenId: TOKEN,
        side: "sell",
        priceX10000: 5100,
        staleCancelCount: 1,
        cooldownUntilTsUtc: NOW + 60_000,
      },
      NOW,
    );

    expect(registry.get(TOKEN, "sell", 5100, NOW + 1)).not.toBeNull();
    expect(registry.get(TOKEN, "sell", 5200, NOW + 1)).toBeNull();
    expect(registry.get(TOKEN, "buy", 5100, NOW + 1)).toBeNull();
  });

  it("returns null when no cooldown exists", () => {
    const registry = new CooldownRegistry(logger() as never);

    expect(registry.get(TOKEN, "sell", 5100, NOW)).toBeNull();
  });

  it("does not log per-attempt suppressions", () => {
    const log = logger();
    const registry = new CooldownRegistry(log as never);
    registry.upsert(
      {
        tokenId: TOKEN,
        side: "sell",
        priceX10000: 5100,
        staleCancelCount: 1,
        cooldownUntilTsUtc: NOW + 60_000,
      },
      NOW,
    );

    for (let i = 0; i < 100; i++) registry.recordEarlySuppression(TOKEN);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sell_cooldown_activated" }),
      "sell cooldown activated",
    );
    expect(registry.snapshot().signalsSuppressedEarlyCooldownTotal).toBe(100);
  });

  it("logs expiry lazily on first read after expiration", () => {
    const log = logger();
    const registry = new CooldownRegistry(log as never);
    registry.upsert(
      {
        tokenId: TOKEN,
        side: "sell",
        priceX10000: 5100,
        staleCancelCount: 1,
        cooldownUntilTsUtc: NOW + 60_000,
      },
      NOW,
    );

    expect(registry.get(TOKEN, "sell", 5100, NOW + 60_001)).toBeNull();

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sell_cooldown_expired" }),
      "sell cooldown expired",
    );
  });

  it("logs expiry once during scheduled sweeps", () => {
    const log = logger();
    const registry = new CooldownRegistry(log as never);
    registry.upsert(
      {
        tokenId: TOKEN,
        side: "sell",
        priceX10000: 5100,
        staleCancelCount: 1,
        cooldownUntilTsUtc: NOW + 60_000,
      },
      NOW,
    );

    expect(registry.sweepExpired(NOW + 60_001)).toBe(1);
    expect(registry.sweepExpired(NOW + 60_002)).toBe(0);

    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "sell_cooldown_expired" }),
      "sell cooldown expired",
    );
  });

  it("does not log expiry twice after lazy deletion", () => {
    const log = logger();
    const registry = new CooldownRegistry(log as never);
    registry.upsert(
      {
        tokenId: TOKEN,
        side: "sell",
        priceX10000: 5100,
        staleCancelCount: 1,
        cooldownUntilTsUtc: NOW + 60_000,
      },
      NOW,
    );

    registry.get(TOKEN, "sell", 5100, NOW + 60_001);
    expect(registry.sweepExpired(NOW + 60_002)).toBe(0);

    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it("logs only material re-extensions", () => {
    const log = logger();
    const registry = new CooldownRegistry(log as never);
    const entry = {
      tokenId: TOKEN,
      side: "sell" as const,
      priceX10000: 5100,
      staleCancelCount: 1,
    };
    registry.upsert({ ...entry, cooldownUntilTsUtc: NOW + 60_000 }, NOW);
    registry.upsert({ ...entry, cooldownUntilTsUtc: NOW + 60_000 }, NOW + 1);
    registry.upsert({ ...entry, cooldownUntilTsUtc: NOW + 70_000 }, NOW + 2);
    registry.upsert({ ...entry, cooldownUntilTsUtc: NOW + 110_001 }, NOW + 3);

    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "sell_cooldown_extended" }),
      "sell cooldown extended",
    );
  });
});

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  };
}
