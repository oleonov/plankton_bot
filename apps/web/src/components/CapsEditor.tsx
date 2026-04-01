import { useState } from "react";

export interface CapsValues {
  maxOpenValueUsdc: number;
  maxActiveMarkets: number;
  maxDustPositions: number;
}

interface CapsInput {
  maxOpenValueUsdc: string;
  maxActiveMarkets: string;
  maxDustPositions: string;
}

function validate(value: string, min: number): string | null {
  if (value.trim() === "") return "Required";
  const n = Number(value);
  if (Number.isNaN(n)) return "Must be a number";
  if (!Number.isFinite(n)) return "Invalid";
  if (n < min) return `Min ${min}`;
  if (n !== Math.floor(n) && min >= 1) return "Must be whole number";
  return null;
}

const FIELDS = [
  { key: "maxOpenValueUsdc" as const, label: "Max Open $", min: 1 },
  { key: "maxActiveMarkets" as const, label: "Max Markets", min: 1 },
  { key: "maxDustPositions" as const, label: "Max Dust", min: 0 },
] as const;

export function useCapsEditor(defaults: CapsValues) {
  const [input, setInput] = useState<CapsInput>({
    maxOpenValueUsdc: String(defaults.maxOpenValueUsdc),
    maxActiveMarkets: String(defaults.maxActiveMarkets),
    maxDustPositions: String(defaults.maxDustPositions),
  });

  const errors = FIELDS.map((f) => ({ key: f.key, error: validate(input[f.key], f.min) }));
  const hasErrors = errors.some((e) => e.error);

  const values: CapsValues = {
    maxOpenValueUsdc: Number(input.maxOpenValueUsdc),
    maxActiveMarkets: Number(input.maxActiveMarkets),
    maxDustPositions: Number(input.maxDustPositions),
  };

  return { input, setInput, hasErrors, values };
}

export function CapsEditor({
  input,
  setInput,
}: {
  input: CapsInput;
  setInput: (fn: (prev: CapsInput) => CapsInput) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
      {FIELDS.map(({ key, label, min }) => {
        const error = validate(input[key], min);
        return (
          <label key={key} style={{ fontSize: 11 }}>
            <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
            <input
              type="text"
              inputMode="numeric"
              value={input[key]}
              onChange={(e) => setInput((c) => ({ ...c, [key]: e.target.value }))}
              style={{
                width: "100%",
                padding: "4px 6px",
                fontSize: 12,
                background: "var(--bg)",
                borderRadius: 4,
                color: "var(--text)",
                border: error ? "1px solid var(--red)" : "1px solid var(--border)",
              }}
            />
            {error && (
              <div style={{ color: "var(--red)", fontSize: 10, marginTop: 2 }}>{error}</div>
            )}
          </label>
        );
      })}
    </div>
  );
}
