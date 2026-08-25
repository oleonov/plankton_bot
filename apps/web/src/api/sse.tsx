import { useEffect, useRef, useState, createContext, useContext, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
export type SSEState = "connected" | "reconnecting" | "disconnected";

const SSE_INVALIDATION_MAP: Record<string, string[][]> = {
  status: [["status"]],
  "metrics:snapshot": [["metrics"], ["pnl-series"]],
  "position:updated": [["positions"]],
  "order:created": [["orders"]],
  "order:filled": [["orders"]],
  "order:cancelled": [["orders"]],
  "fill:new": [["fills"], ["pnl-series"], ["metrics"]],
  "family:state_changed": [["families"], ["metrics-families"], ["status"]],
  "risk:event": [["risk-events"]],
  transitions: [["families", "transitions"]],
};

const SSEContext = createContext<SSEState>("disconnected");

export function useSSEState(): SSEState {
  return useContext(SSEContext);
}

export function SSEProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SSEState>("disconnected");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = "/api/v1/events";
    const connect = () => {
      const current = esRef.current;
      if (current && current.readyState !== EventSource.CLOSED) return;

      current?.close();
      const es = new EventSource(url);
      esRef.current = es;
      setState("reconnecting");

      es.onopen = () => {
        if (esRef.current === es) setState("connected");
      };
      es.onerror = () => {
        if (esRef.current !== es) return;
        setState(es.readyState === EventSource.CONNECTING ? "reconnecting" : "disconnected");
      };

      for (const eventType of Object.keys(SSE_INVALIDATION_MAP)) {
        es.addEventListener(eventType, () => {
          const keys = SSE_INVALIDATION_MAP[eventType];
          if (keys) {
            for (const key of keys) {
              void queryClient.invalidateQueries({ queryKey: key });
            }
          }
        });
      }
    };

    const reconnectWhenActive = () => {
      if (document.visibilityState !== "hidden") connect();
    };

    connect();
    document.addEventListener("visibilitychange", reconnectWhenActive);
    window.addEventListener("pageshow", reconnectWhenActive);
    window.addEventListener("online", reconnectWhenActive);

    return () => {
      document.removeEventListener("visibilitychange", reconnectWhenActive);
      window.removeEventListener("pageshow", reconnectWhenActive);
      window.removeEventListener("online", reconnectWhenActive);
      esRef.current?.close();
      esRef.current = null;
      setState("disconnected");
    };
  }, [queryClient]);

  return <SSEContext.Provider value={state}>{children}</SSEContext.Provider>;
}
