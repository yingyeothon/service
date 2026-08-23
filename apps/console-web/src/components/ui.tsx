import {
  Alert,
  Badge as MantineBadge,
  Button,
  Code,
  Group,
  Loader,
  Text,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";

const NOTICE: Record<
  "info" | "error" | "success" | "warn",
  { color: string; icon: ReactNode }
> = {
  info: { color: "brand", icon: <IconInfoCircle size={18} /> },
  error: { color: "red", icon: <IconX size={18} /> },
  success: { color: "green", icon: <IconCheck size={18} /> },
  warn: { color: "yellow", icon: <IconAlertTriangle size={18} /> },
};

export function Notice({
  kind = "info",
  children,
}: {
  kind?: "info" | "error" | "success" | "warn";
  children: ReactNode;
}) {
  const { color, icon } = NOTICE[kind];
  return (
    <Alert
      color={color}
      icon={icon}
      mb="sm"
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </Alert>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <Group gap="xs" role="status" aria-live="polite" my="sm">
      <Loader size="xs" />
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}

/** Read-only value with a copy button (with a manual fallback when the clipboard API fails). */
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
    <Group gap="xs" wrap="nowrap" my={4}>
      <Text size="sm" c="dimmed" w={140} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Code style={{ overflowWrap: "anywhere", userSelect: "all" }}>
        {value}
      </Code>
      <Button size="compact-xs" variant="default" onClick={() => void copy()}>
        {copied === "yes"
          ? "Copied"
          : copied === "failed"
            ? "Select & copy manually"
            : "Copy"}
      </Button>
    </Group>
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
      <Text size="sm">
        <strong>{label}</strong> — shown once. Copy it now; it cannot be
        retrieved later.
      </Text>
      <CopyField label={label} value={value} />
      <Button size="compact-sm" variant="default" onClick={onDismiss}>
        I have copied it
      </Button>
    </Notice>
  );
}

const TONE_COLOR: Record<string, string> = {
  neutral: "gray",
  accent: "brand",
  ok: "green",
  warn: "yellow",
  danger: "red",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <MantineBadge variant="light" color={TONE_COLOR[tone] ?? "gray"}>
      {children}
    </MantineBadge>
  );
}

/** Two-click destructive button: first click arms, second confirms. */
export function Confirm({
  label,
  confirmLabel = "Confirm",
  color = "red",
  variant = "light",
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  color?: string;
  variant?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [arm, setArm] = useState(false);
  if (!arm)
    return (
      <Button
        size="compact-sm"
        color={color}
        variant={variant}
        disabled={disabled}
        onClick={() => setArm(true)}
      >
        {label}
      </Button>
    );
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="compact-sm"
        color={color}
        variant="filled"
        onClick={() => {
          setArm(false);
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button size="compact-sm" variant="default" onClick={() => setArm(false)}>
        Cancel
      </Button>
    </Group>
  );
}
