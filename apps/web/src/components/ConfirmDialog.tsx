interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  runtimeMode?: string;
  caps?: string;
  children?: React.ReactNode;
  disableConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  runtimeMode,
  caps,
  children,
  disableConfirm,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  const isLive = runtimeMode === "live-lite";
  const confirmBtnClass = isLive ? "btn-danger" : "btn-success";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "var(--bg-card)",
          borderRadius: 8,
          padding: 20,
          minWidth: 340,
          maxWidth: 480,
          border: isLive ? "2px solid var(--red)" : "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
          {description}
        </div>
        {isLive && (
          <div
            style={{
              border: "1px solid var(--red)",
              borderRadius: 4,
              padding: "8px 12px",
              marginBottom: 12,
              fontSize: 11,
              color: "var(--red)",
              fontWeight: 700,
            }}
          >
            LIVE MODE — real orders will be placed
          </div>
        )}
        {caps && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12 }}>{caps}</div>
        )}
        {children}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className={confirmBtnClass} onClick={onConfirm} disabled={disableConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
