import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/*
 * The one confirmation mechanism of the console: a modal whose confirm button
 * repeats the verb ("Delete team", "Kick alice", "Revoke token"). A reason
 * field is added when a platform admin acts on someone else's content
 * (`docs/decisions.md` *Show (console)*, decision 12).
 */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button. */
  danger?: boolean;
  reason?: {
    required: boolean;
    maxLength?: number;
    label?: string;
    placeholder?: string;
  };
}

export interface ConfirmResult {
  ok: boolean;
  reason?: string;
}

function ReasonConfirm({
  opts,
  onSettle,
}: {
  opts: ConfirmOptions;
  onSettle: (r: ConfirmResult) => void;
}) {
  const [reason, setReason] = useState("");
  const r = opts.reason!;
  const blocked = r.required && reason.trim() === "";
  return (
    <Stack gap="sm">
      {opts.message && <Text size="sm">{opts.message}</Text>}
      <TextInput
        label={r.label ?? "Reason"}
        placeholder={r.placeholder ?? "Why?"}
        value={reason}
        maxLength={r.maxLength}
        onChange={(e) => setReason(e.currentTarget.value)}
        data-autofocus
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={() => onSettle({ ok: false })}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          color={opts.danger ? "red" : undefined}
          disabled={blocked}
          onClick={() => {
            const v = reason.trim();
            onSettle({ ok: true, reason: v === "" ? undefined : v });
          }}
        >
          {opts.confirmLabel}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * `const confirm = useConfirm(); if ((await confirm({...})).ok) …`. Modals
 * still open when the page unmounts are closed, so a modal never outlives
 * the list it would have reloaded.
 */
export function useConfirm() {
  // Only the modals this hook opened are closed on unmount: a row menu
  // unmounting under someone else's confirm must not dismiss it.
  const mine = useRef<Set<string>>(new Set());
  useEffect(() => {
    const opened = mine.current;
    return () => {
      for (const id of opened) modals.close(id);
      opened.clear();
    };
  }, []);
  return useCallback(
    (opts: ConfirmOptions) =>
      new Promise<ConfirmResult>((resolve) => {
        let settled = false;
        let id = "";
        const settle = (r: ConfirmResult) => {
          if (settled) return;
          settled = true;
          mine.current.delete(id);
          resolve(r);
        };
        if (opts.reason) {
          id = modals.open({
            title: opts.title,
            onClose: () => settle({ ok: false }),
            children: (
              <ReasonConfirm
                opts={opts}
                onSettle={(r) => {
                  settle(r);
                  modals.close(id);
                }}
              />
            ),
          });
          mine.current.add(id);
          return;
        }
        id = modals.openConfirmModal({
          title: opts.title,
          children: opts.message ? (
            <Text size="sm">{opts.message}</Text>
          ) : undefined,
          labels: {
            confirm: opts.confirmLabel,
            cancel: opts.cancelLabel ?? "Cancel",
          },
          confirmProps: { color: opts.danger ? "red" : undefined },
          cancelProps: { variant: "default" },
          onConfirm: () => settle({ ok: true }),
          onCancel: () => settle({ ok: false }),
          onClose: () => settle({ ok: false }),
        });
        mine.current.add(id);
      }),
    [],
  );
}
