import {
  Alert,
  Badge as MantineBadge,
  Button,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

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

/** Read-only value with a copy button (with a manual fallback when the clipboard API fails). */
export function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <Group gap="xs" wrap="nowrap" my={4}>
      <Text size="sm" c="dimmed" w={140} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Code style={{ overflowWrap: "anywhere", userSelect: "all" }}>
        {value}
      </Code>
      <CopyButton value={value} idle="Copy" aria={`Copy ${label}`} />
    </Group>
  );
}

/** Multi-line read-only block with one copy button; lines are `name=value`. */
export function CopyBlock({
  label,
  lines,
}: {
  label: string;
  lines: readonly (readonly [string, string])[];
}) {
  const value = lines.map(([k, v]) => `${k}=${v}`).join("\n");
  const id = useId();
  return (
    <Stack gap={4} my={4}>
      <Text size="sm" c="dimmed" id={id}>
        {label}
      </Text>
      <Code
        block
        aria-labelledby={id}
        style={{
          userSelect: "all",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </Code>
      <Group>
        <CopyButton value={value} idle="Copy all" aria={`Copy ${label}`} />
      </Group>
    </Stack>
  );
}

function CopyButton({
  value,
  idle,
  aria,
}: {
  value: string;
  idle: string;
  aria: string;
}) {
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
  const text =
    copied === "yes"
      ? "Copied"
      : copied === "failed"
        ? "Select & copy manually"
        : idle;
  return (
    <>
      <Button
        size="compact-xs"
        variant="default"
        aria-label={aria}
        onClick={() => void copy()}
      >
        {text}
      </Button>
      <span
        role="status"
        aria-live="polite"
        style={{ position: "absolute", left: -9999 }}
      >
        {copied === "no" ? "" : text}
      </span>
    </>
  );
}

/**
 * A destructive action a platform admin may only take with a stated reason
 * (`docs/decisions.md` *Show (console)*, decision 12). The reason is required
 * only when `required` is set, so the same control serves an owner acting on
 * their own content and an admin acting beyond it.
 */
export function ConfirmWithReason({
  label,
  confirmLabel = "Confirm",
  required,
  placeholder = "Why?",
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  /** Demand a reason before the confirm button does anything. */
  required: boolean;
  placeholder?: string;
  onConfirm: (reason: string | undefined) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [arm, setArm] = useState(false);
  const [reason, setReason] = useState("");
  if (!arm)
    return (
      <Button
        size="compact-sm"
        color="red"
        variant="light"
        disabled={disabled}
        onClick={() => setArm(true)}
      >
        {label}
      </Button>
    );
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <TextInput
        size="xs"
        placeholder={placeholder}
        value={reason}
        aria-label="Reason"
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setReason(e.currentTarget.value)
        }
        style={{ minWidth: 220 }}
      />
      <Button
        size="compact-sm"
        color="red"
        variant="filled"
        disabled={required && reason.trim() === ""}
        onClick={() => {
          setArm(false);
          const r = reason.trim();
          setReason("");
          void onConfirm(r === "" ? undefined : r);
        }}
      >
        {confirmLabel}
      </Button>
      <Button
        size="compact-sm"
        variant="default"
        onClick={() => {
          setArm(false);
          setReason("");
        }}
      >
        Cancel
      </Button>
    </Group>
  );
}
