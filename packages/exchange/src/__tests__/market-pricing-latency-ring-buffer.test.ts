import { describe, expect, it } from "vitest";
import { LatencySampleRingBuffer } from "../live/market-pricing-stream.js";

describe("LatencySampleRingBuffer", () => {
  it("returns FIFO samples before capacity is reached", () => {
    const buffer = new LatencySampleRingBuffer(4);

    buffer.pushMany([10, 20, 30]);

    expect(buffer.toArray()).toEqual([10, 20, 30]);
  });

  it("returns FIFO samples exactly at capacity", () => {
    const buffer = new LatencySampleRingBuffer(4);

    buffer.pushMany([10, 20, 30, 40]);

    expect(buffer.toArray()).toEqual([10, 20, 30, 40]);
  });

  it("returns the newest samples in FIFO order after wrapping", () => {
    const buffer = new LatencySampleRingBuffer(4);

    buffer.pushMany([10, 20, 30, 40, 50, 60]);

    expect(buffer.toArray()).toEqual([30, 40, 50, 60]);
  });
});
