import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { registerOnUnauthorized } from "../api/client.ts";
import { LoginPage } from "../pages/LoginPage.tsx";

type AuthState = "loading" | "authenticated" | "unauthenticated" | "server_error";

function checkSession(): Promise<AuthState> {
  return fetch("/api/v1/auth/me")
    .then((res) => {
      if (res.status === 401) return "unauthenticated" as const;
      if (res.ok) return "authenticated" as const;
      return "server_error" as const;
    })
    .catch(() => "server_error" as const);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleLogin = useCallback(() => {
    setState("authenticated");
  }, []);

  const handleRetry = useCallback(() => {
    setState("loading");
    void checkSession().then(setState);
  }, []);

  // Register unauthorized callback
  useEffect(() => {
    return registerOnUnauthorized(() => setState("unauthenticated"));
  }, []);

  // Check session on mount — only 401 means "not logged in", other errors get a retry
  useEffect(() => {
    void checkSession().then((result) => {
      if (result === "server_error") {
        // Single retry after 3s for transient startup issues
        setTimeout(() => {
          void checkSession().then(setState);
        }, 3000);
      } else {
        setState(result);
      }
    });
  }, []);

  // Heartbeat while authenticated — only 401 triggers logout
  useEffect(() => {
    if (state !== "authenticated") {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      return;
    }

    heartbeatRef.current = setInterval(
      () => {
        fetch("/api/v1/auth/me")
          .then((res) => {
            if (res.status === 401) setState("unauthenticated");
          })
          .catch(() => {
            /* network error — transient, don't logout */
          });
      },
      5 * 60 * 1000,
    );

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [state]);

  if (state === "loading") {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading...</div>
    );
  }

  if (state === "server_error") {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
        <p>Cannot reach server</p>
        <button
          onClick={handleRetry}
          style={{
            marginTop: 12,
            padding: "6px 16px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (state === "unauthenticated") {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <>{children}</>;
}
