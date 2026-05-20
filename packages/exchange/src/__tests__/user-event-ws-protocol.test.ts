import { describe, expect, it } from "vitest";
import {
  buildUserSubscriptionPayload,
  isUserPongPayload,
  normalizeConditionIds,
} from "../live/user-event-ws-protocol.js";

describe("user-event WS protocol helpers", () => {
  it("normalizes condition ids deterministically", () => {
    expect(normalizeConditionIds([" cond-b ", "cond-a", "", "cond-a"])).toEqual([
      "cond-a",
      "cond-b",
    ]);
  });

  it("builds authenticated user subscription payloads", () => {
    expect(
      JSON.parse(
        buildUserSubscriptionPayload({
          auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
          conditionIds: ["cond-a"],
          operation: "subscribe",
          initialDump: true,
        }),
      ),
    ).toEqual({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      type: "user",
      operation: "subscribe",
      markets: ["cond-a"],
      initial_dump: true,
    });
  });

  it("recognizes Polymarket PONG text frames", () => {
    expect(isUserPongPayload("PONG")).toBe(true);
    expect(isUserPongPayload(" pong ")).toBe(true);
    expect(isUserPongPayload("PING")).toBe(false);
  });
});
