import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server.ts";

// Node 24+ ships an experimental Web Storage implementation that jsdom-provided
// `window.localStorage` does not fully delegate to (missing `clear()` in Node
// 25). Replace it with a minimal in-memory shim so tests can rely on the
// standard Storage surface regardless of Node version.
function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: shim,
  });
}

installLocalStorageShim();

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => {
  window.localStorage.clear();
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());
