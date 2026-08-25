import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSEProvider, useSSEState } from "../../api/sse.tsx";

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener() {}

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  disconnect() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

function StateProbe() {
  return <div>{useSSEState()}</div>;
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

describe("SSEProvider", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    setVisibility("visible");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reconnects a closed stream once when the page becomes visible again", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SSEProvider>
          <StateProbe />
        </SSEProvider>
      </QueryClientProvider>,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    act(() => MockEventSource.instances[0]?.open());
    expect(screen.getByText("connected")).toBeInTheDocument();

    setVisibility("hidden");
    act(() => MockEventSource.instances[0]?.disconnect());
    expect(screen.getByText("disconnected")).toBeInTheDocument();

    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(MockEventSource.instances).toHaveLength(2);
    expect(screen.getByText("reconnecting")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
    });
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => MockEventSource.instances[1]?.open());
    expect(screen.getByText("connected")).toBeInTheDocument();

    view.unmount();
    expect(MockEventSource.instances[1]?.readyState).toBe(MockEventSource.CLOSED);
  });
});
