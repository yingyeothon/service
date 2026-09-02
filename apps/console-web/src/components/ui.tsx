import {
  Alert,
  Badge as MantineBadge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
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
  type DragEvent,
  type ReactNode,
} from "react";

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
