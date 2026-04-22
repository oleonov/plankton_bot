/**
 * BoundedQueue<T> — fixed-capacity FIFO ring buffer with drop-oldest overflow semantics.
 *
 * push() always succeeds: if full it drops the front item and returns it as `droppedItem`.
 * All operations are O(1) amortized (array splice on drop is O(n) but capacity is small).
 */
export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("BoundedQueue capacity must be ≥ 1");
    this.cap = capacity;
  }

  get capacity(): number {
    return this.cap;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Add `item` to the back of the queue.
   *
   * Returns `{ accepted: true }` when the item fits within capacity.
   * When at capacity, the front item is evicted first; the method then returns
   * `{ accepted: true, droppedItem: <evicted front item> }`.
   * The returned `accepted` is always true — the new item is always enqueued.
   */
  push(item: T): { accepted: true; droppedItem?: T } {
    if (this.items.length < this.cap) {
      this.items.push(item);
      return { accepted: true };
    }
    const droppedItem = this.items.shift()!;
    this.items.push(item);
    return { accepted: true, droppedItem };
  }

  /** Remove and return the front item, or undefined if empty. */
  shift(): T | undefined {
    return this.items.shift();
  }

  /** Empty the queue, discarding all items. */
  clear(): void {
    this.items.length = 0;
  }
}
