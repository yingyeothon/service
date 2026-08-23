import { useEffect, useState, type ReactNode } from "react";

export function Notice({
  kind = "info",
  children,
}: {
  kind?: "info" | "error" | "success" | "warn";
  children: ReactNode;
}) {
  return (
    <div
      className={`notice notice-${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}

/** Read-only value with a copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  useEffect(() => {
    if (copied === "no") return;
    const t = setTimeout(() => setCopied("no"), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <code className="copy-value">{value}</code>
      <button type="button" className="btn btn-sm" onClick={() => void copy()}>
        {copied === "yes"
          ? "Copied"
          : copied === "failed"
            ? "Select & copy manually"
            : "Copy"}
      </button>
    </div>
  );
}

/** A secret shown exactly once: the API never returns it again. */
export function SecretOnce({
  label,
  value,
  onDismiss,
}: {
  label: string;
  value: string;
  onDismiss: () => void;
}) {
  return (
    <Notice kind="warn">
      <p>
        <strong>{label}</strong> — shown once. Copy it now; it cannot be
        retrieved later.
      </p>
      <CopyField label={label} value={value} />
      <button type="button" className="btn btn-sm" onClick={onDismiss}>
        I have copied it
      </button>
    </Notice>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Two-click destructive button: first click arms, second confirms. */
export function Confirm({
  label,
  confirmLabel = "Confirm",
  className = "btn btn-danger btn-sm",
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  className?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [arm, setArm] = useState(false);
  if (!arm)
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => setArm(true)}
      >
        {label}
      </button>
    );
  return (
    <span className="confirm">
      <button
        type="button"
        className={className}
        onClick={() => {
          setArm(false);
          void onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setArm(false)}
      >
        Cancel
      </button>
    </span>
  );
}
