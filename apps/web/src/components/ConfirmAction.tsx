import { useState } from "react";

type Phase = "idle" | "confirm" | "pending";

export function ConfirmAction({
  label,
  confirmText,
  variant = "danger",
  showReason = false,
  onConfirm,
  isPending = false,
}: {
  label: string;
  confirmText: string;
  variant?: "danger" | "success";
  showReason?: boolean;
  onConfirm: (reason?: string) => void;
  isPending?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [reason, setReason] = useState("");

  if (isPending || phase === "pending") {
    return <button className="btn-pending" disabled>{label}&hellip;</button>;
  }

  if (phase === "confirm") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{confirmText}</span>
        {showReason && (
          <input
            type="text"
            placeholder="reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ width: 120, fontSize: 11 }}
          />
        )}
        <button
          className={variant === "danger" ? "btn-danger" : "btn-success"}
          onClick={() => {
            setPhase("pending");
            onConfirm(reason || undefined);
          }}
        >
          Confirm
        </button>
        <button className="btn-secondary" onClick={() => { setPhase("idle"); setReason(""); }}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      className={variant === "danger" ? "btn-danger" : "btn-success"}
      onClick={() => setPhase("confirm")}
    >
      {label}
    </button>
  );
}
