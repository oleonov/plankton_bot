import { describe, it, expect } from "vitest";
import {
  createTokenId,
  createOrderId,
  createFillId,
  createPositionId,
  createLotId,
  createCommandId,
  createBotRunId,
} from "./ids.js";

describe("branded ID constructors", () => {
  const constructors = [
    ["TokenId", createTokenId],
    ["OrderId", createOrderId],
    ["FillId", createFillId],
    ["PositionId", createPositionId],
    ["LotId", createLotId],
    ["CommandId", createCommandId],
    ["BotRunId", createBotRunId],
  ] as const;

  for (const [name, create] of constructors) {
    it(`${name}: preserves the raw string value`, () => {
      const raw = `test-${name}-123`;
      const branded = create(raw);
      expect(branded as string).toBe(raw);
    });

    it(`${name}: empty string is a valid input`, () => {
      const branded = create("");
      expect(branded as string).toBe("");
    });
  }
});
