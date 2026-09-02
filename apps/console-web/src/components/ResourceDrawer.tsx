import {
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { useConfirm, type ConfirmOptions } from "../lib/confirm";
import { Notice } from "./ui";

/*
 * Create and edit both happen in a right-hand drawer: the list's `New <noun>`
 * button and the detail page's `Edit` button open the same shape. The drawer
 * is presentational; the page owns the form state (see `useDrawerForm`) and
 * the request, and closes the drawer only when the request returned a row.
 */

/** The submit row every form ends with; `onCancel` adds the white button. */
export function FormFooter({
  submitLabel,
  busy,
  disabled,
  onCancel,
  cancelLabel = "Cancel",
}: {
  submitLabel: string;
  busy?: boolean;
  disabled?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <Group justify="flex-end" gap="xs">
      {onCancel && (
        <Button variant="default" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
      )}
      <Button type="submit" disabled={disabled || busy} loading={busy}>
        {submitLabel}
      </Button>
    </Group>
  );
}

export interface DangerAction {
  /** The button and the confirm button: "Delete team". */
  label: string;
  /** One sentence on what deletion refuses or takes with it. */
  description: ReactNode;
  onConfirm: (reason?: string) => void | Promise<void>;
  disabled?: boolean;
  confirmTitle?: string;
  confirmMessage?: ReactNode;
  reason?: ConfirmOptions["reason"];
}

/** The foot of an edit drawer: the resource's one destructive verb. */
export function DangerZone({ action }: { action: DangerAction }) {
  const confirm = useConfirm();
  return (
    <Box mt="xl">
      <Divider mb="md" />
      <Text size="sm" fw={500} mb={4}>
        Danger zone
      </Text>
      <Text size="sm" c="dimmed" mb="sm">
        {action.description}
      </Text>
      <Button
        color="red"
        variant="outline"
        disabled={action.disabled}
        onClick={() =>
          void confirm({
            title: action.confirmTitle ?? `${action.label}?`,
            message: action.confirmMessage ?? action.description,
            confirmLabel: action.label,
            danger: true,
            reason: action.reason,
          }).then((r) => (r.ok ? action.onConfirm(r.reason) : undefined))
        }
      >
        {action.label}
      </Button>
    </Box>
  );
}

export function ResourceDrawer({
  opened,
  onClose,
  title,
  submitLabel,
  onSubmit,
  busy,
  disabled,
  error,
  children,
  danger,
  size = "md",
  hideFooter,
}: {
  opened: boolean;
  onClose: () => void;
  /** "New team" / "Edit team". */
  title: string;
  /** "Create team" / "Save". */
  submitLabel: string;
  onSubmit: (e: FormEvent) => void | Promise<void>;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  children: ReactNode;
  danger?: DangerAction;
  size?: "md" | "lg";
  /** A read-only view of the same drawer (no form to submit). */
  hideFooter?: boolean;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={title}
      size={size === "lg" ? "lg" : "md"}
    >
      <form onSubmit={(e) => void onSubmit(e)}>
        <Stack gap="md">{children}</Stack>
        {error && (
          <Box mt="md">
            <Notice kind="error">{error}</Notice>
          </Box>
        )}
        {!hideFooter && (
          <Box
            mt="lg"
            py="sm"
            style={{
              position: "sticky",
              bottom: 0,
              background: "var(--yyt-canvas)",
              borderTop: "1px solid var(--yyt-hairline)",
            }}
          >
            <FormFooter
              submitLabel={submitLabel}
              busy={busy}
              disabled={disabled}
              onCancel={onClose}
            />
          </Box>
        )}
      </form>
      {danger && <DangerZone action={danger} />}
    </Drawer>
  );
}

/**
 * Drawer form state for a page: `open()` resets the values from `initial`,
 * so a reopened drawer never shows a half-typed draft from last time.
 */
export function useDrawerForm<T>(initial: () => T) {
  const [opened, setOpened] = useState(false);
  const [form, setForm] = useState<T>(initial);
  const open = useCallback(() => {
    setForm(initial());
    setOpened(true);
  }, [initial]);
  const close = useCallback(() => setOpened(false), []);
  const patch = useCallback(
    (p: Partial<T>) => setForm((f) => ({ ...f, ...p })),
    [],
  );
  return { opened, open, close, form, setForm, patch };
}
