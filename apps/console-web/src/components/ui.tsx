import {
  Alert,
  Anchor,
  Badge as MantineBadge,
  Button,
  Card,
  Code,
  Group,
  Paper,
  Stack,
  Table,
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
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { Loading } from "./Loading";

const NOTICE: Record<
  "info" | "error" | "success" | "warn",
  { color: string; icon: ReactNode }
> = {
  info: { color: "link", icon: <IconInfoCircle size={18} /> },
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

/** @deprecated Use `Loading` (inline) or `PageSkeleton` (page body). */
export function Spinner({ label }: { label?: string }) {
  return <Loading label={label} />;
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
  // The cream signature surface (DESIGN.md): the one moment the console
  // must make a reader stop, so it is the only place this colour appears
  // besides the Home hero.
  return (
    <Paper
      role="alert"
      p="lg"
      mb="md"
      withBorder={false}
      style={{
        background: "var(--yyt-signature-cream)",
        color: "var(--yyt-ink)",
      }}
    >
      <Text size="sm" mb="xs">
        <strong>{label}</strong> — shown once. Copy it now; it cannot be
        retrieved later.
      </Text>
      <CopyField label={label} value={value} />
      <Button variant="default" mt="xs" onClick={onDismiss}>
        I have copied it
      </Button>
    </Paper>
  );
}

const TONE_COLOR: Record<string, string> = {
  neutral: "gray",
  accent: "ink",
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
  maxLength,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  /** Demand a reason before the confirm button does anything. */
  required: boolean;
  placeholder?: string;
  /** The server's cap, so an over-long reason is stopped here, not by a 400. */
  maxLength?: number;
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
        maxLength={maxLength}
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

/** The submit row of every inline form: a submit button and, when the form can be dismissed, a Cancel. */
export function FormActions({
  submitLabel,
  disabled,
  onCancel,
}: {
  submitLabel: string;
  disabled?: boolean;
  onCancel?: () => void;
}) {
  return (
    <Group>
      <Button type="submit" disabled={disabled}>
        {submitLabel}
      </Button>
      {onCancel && (
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </Group>
  );
}

/** A table cell whose content is an in-app link (the name column of every list). */
export function LinkCell({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Table.Td>
      <Anchor component={Link} to={to} size="sm">
        {children}
      </Anchor>
    </Table.Td>
  );
}

/** The last card of a settings tab: one sentence on what deletion refuses, then the confirm. */
export function DangerCard({
  label,
  onConfirm,
  disabled,
  children,
}: {
  label: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Card withBorder padding="sm">
      <Text size="sm" mb="xs">
        {children}
      </Text>
      <Confirm
        label={label}
        confirmLabel="Delete"
        onConfirm={onConfirm}
        disabled={disabled}
      />
    </Card>
  );
}

/**
 * The dashed click-or-drop target the uploaders share. It owns the hover
 * state and the hidden input; the page decides what to do with the files
 * (one or many) and what the zone says.
 */
export function DropZone({
  label,
  accept,
  multiple,
  dimmed,
  onFiles,
  children,
}: {
  /** Accessible name of the zone. */
  label: string;
  accept?: string;
  multiple?: boolean;
  /** Render the caption dimmed (nothing chosen yet). */
  dimmed?: boolean;
  /** The dropped or chosen files; `null` when the input reports none. */
  onFiles: (files: FileList | null) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFiles(e.dataTransfer.files);
  };
  return (
    <Paper
      withBorder
      p="md"
      mb="sm"
      role="button"
      tabIndex={0}
      aria-label={label}
      style={{
        borderStyle: "dashed",
        cursor: "pointer",
        background: over ? "var(--yyt-surface-soft)" : undefined,
        borderRadius: 10,
        textAlign: "center",
      }}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") &&
        (e.preventDefault(), inputRef.current?.click())
      }
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <Text size="sm" c={dimmed ? "dimmed" : undefined}>
        {children}
      </Text>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => onFiles(e.target.files)}
      />
    </Paper>
  );
}
