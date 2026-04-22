import { describe, it, expect } from "vitest";
import { BoundedQueue } from "../live/bounded-queue.js";

describe("BoundedQueue", () => {
  it("starts empty", () => {
    const q = new BoundedQueue<number>(4);
    expect(q.size).toBe(0);
    expect(q.capacity).toBe(4);
  });

  it("throws for zero capacity", () => {
    expect(() => new BoundedQueue<number>(0)).toThrow(RangeError);
  });

  it("accepts items up to capacity without dropping", () => {
    const q = new BoundedQueue<number>(3);
    expect(q.push(1)).toEqual({ accepted: true });
    expect(q.push(2)).toEqual({ accepted: true });
    expect(q.push(3)).toEqual({ accepted: true });
    expect(q.size).toBe(3);
  });

  it("drops the front item when at capacity (drop-oldest semantics)", () => {
    const q = new BoundedQueue<number>(3);
    q.push(10);
    q.push(20);
    q.push(30);
    // Queue is full; next push evicts the front (10).
    const result = q.push(40);
    expect(result.accepted).toBe(true);
    expect(result.droppedItem).toBe(10);
    expect(q.size).toBe(3);
  });

  it("preserves FIFO order after drop-oldest overflow", () => {
    const q = new BoundedQueue<number>(2);
    q.push(1);
    q.push(2);
    // Overflow evicts 1, enqueues 3 → queue contains [2, 3]
    q.push(3);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBeUndefined();
  });

  it("shift preserves FIFO order on normal fill", () => {
    const q = new BoundedQueue<string>(4);
    q.push("a");
    q.push("b");
    q.push("c");
    expect(q.shift()).toBe("a");
    expect(q.shift()).toBe("b");
    expect(q.shift()).toBe("c");
    expect(q.shift()).toBeUndefined();
  });

  it("clear empties the queue", () => {
    const q = new BoundedQueue<number>(4);
    q.push(1);
    q.push(2);
    q.push(3);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.shift()).toBeUndefined();
  });

  it("returns no droppedItem when push is within capacity", () => {
    const q = new BoundedQueue<number>(5);
    const result = q.push(99);
    expect(result.droppedItem).toBeUndefined();
  });

  it("consecutive overflows always evict the current front", () => {
    const q = new BoundedQueue<number>(2);
    q.push(1);
    q.push(2);
    const r1 = q.push(3); // evicts 1
    expect(r1.droppedItem).toBe(1);
    const r2 = q.push(4); // evicts 2
    expect(r2.droppedItem).toBe(2);
    // Queue is [3, 4]
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBe(4);
  });
});
