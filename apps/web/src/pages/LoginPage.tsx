import { useState, useEffect, type FormEvent } from "react";

interface LoginPageProps {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [usernameRequired, setUsernameRequired] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/v1/auth/config")
      .then((r) => r.json())
      .then((body) => {
        if (body.data?.usernameRequired) setUsernameRequired(true);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username || undefined, password }),
      });

      const body = await res.json();

      if (res.status === 501) {
        setError("Login not available -- configure PLANKTON_AUTH_PASSWORD on the server");
      } else if (!body.ok) {
        setError(body.error?.message ?? "Login failed");
      } else {
        onLogin();
      }
    } catch {
      setError("Network error -- is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "var(--bg)",
      }}
    >
      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        style={{
          background: "var(--bg-nav)",
          padding: 32,
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          width: 320,
        }}
      >
        <span style={{ fontWeight: 700, color: "var(--blue)", fontSize: 18, textAlign: "center" }}>
          PLANKTON
        </span>
        {usernameRequired && (
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            style={{
              padding: "8px 12px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 14,
            }}
          />
        )}
        <input
          type="password"
          placeholder="Password"
          autoFocus={!usernameRequired}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            padding: "8px 12px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={loading || !password || (usernameRequired && !username)}
          style={{
            padding: "8px 16px",
            borderRadius: 4,
            border: "none",
            background: "var(--blue)",
            color: "#fff",
            fontSize: 14,
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
        {error && (
          <div style={{ color: "var(--red, #f66)", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        )}
      </form>
    </div>
  );
}
