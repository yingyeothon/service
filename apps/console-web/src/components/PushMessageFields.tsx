import {
  ActionIcon,
  Box,
  Button,
  Code,
  Collapse,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconX } from "@tabler/icons-react";
import { Fragment, useId, useState, type ReactNode } from "react";
import {
  PAYLOAD_MAX_BYTES,
  PLACEHOLDER_HINT,
  previewMessage,
  templateVars,
  type MessageForm,
  type MessageProblems,
  type OptionsForm,
} from "../lib/pushCampaign";
import type { PushMessageText } from "../types";

/*
 * The form parts the template, campaign and broadcast drawers share
 * (`docs/push.md` *Templates*): the message fields with the data editor, the
 * rendered message, and the delivery options.
 */

/** Title, body and the data key/value rows. */
export function MessageFields({
  form,
  onChange,
  problems,
  variables = true,
}: {
  form: MessageForm;
  onChange: (next: MessageForm) => void;
  problems: MessageProblems;
  /** Whether `{{variables}}` mean anything here (not in a broadcast). */
  variables?: boolean;
}) {
  const setRow = (i: number, patch: Partial<MessageForm["data"][number]>) =>
    onChange({
      ...form,
      data: form.data.map((r, at) => (at === i ? { ...r, ...patch } : r)),
    });
  return (
    <>
      <TextInput
        label="Title"
        description="Leave empty for a data-only message, which the app handles itself."
        value={form.title}
        onChange={(e) => onChange({ ...form, title: e.currentTarget.value })}
        error={problems.title}
      />
      <Textarea
        label="Body"
        description={variables ? PLACEHOLDER_HINT : undefined}
        value={form.body}
        onChange={(e) => onChange({ ...form, body: e.currentTarget.value })}
        error={problems.body}
        autosize
        minRows={2}
        maxRows={8}
      />
      <Stack gap={6} role="group" aria-label="Data">
        <Text size="sm" fw={500}>
          Data
        </Text>
        <Text size="xs" c="dimmed">
          Key/value strings handed to the app.
          {variables && " A value may hold {{variables}}; a key is literal."}
        </Text>
        {form.data.map((r, i) => (
          <Group key={i} gap="xs" wrap="nowrap">
            <TextInput
              aria-label={`Data key ${i + 1}`}
              placeholder="key"
              value={r.key}
              onChange={(e) => setRow(i, { key: e.currentTarget.value })}
              style={{ flex: 1, minWidth: 0 }}
            />
            <TextInput
              aria-label={`Data value ${i + 1}`}
              placeholder="value"
              value={r.value}
              onChange={(e) => setRow(i, { value: e.currentTarget.value })}
              style={{ flex: 2, minWidth: 0 }}
            />
            <ActionIcon
              variant="subtle"
              aria-label={`Remove data row ${i + 1}`}
              onClick={() =>
                onChange({
                  ...form,
                  data: form.data.filter((_r, at) => at !== i),
                })
              }
            >
              <IconX size={16} aria-hidden="true" />
            </ActionIcon>
          </Group>
        ))}
        {problems.data && (
          <Text size="xs" c="red" role="alert">
            {problems.data}
          </Text>
        )}
        <Box>
          <Button
            variant="default"
            size="compact-sm"
            onClick={() =>
              onChange({
                ...form,
                data: [...form.data, { key: "", value: "" }],
              })
            }
          >
            Add data key
          </Button>
        </Box>
      </Stack>
    </>
  );
}

/**
 * Variable names as code chips. The blank between two chips is what lets a
 * long list wrap: adjacent inline boxes offer no break.
 */
export function VarCodes({ names }: { names: readonly string[] }) {
  return names.map((v, i) => (
    <Fragment key={v}>
      {i > 0 && " "}
      <Code>{v}</Code>
    </Fragment>
  ));
}

/** A message as it is sent: title, body, data lines. */
export function MessageBox({
  message,
  label,
  foot,
}: {
  message: PushMessageText;
  /** The box's accessible name: "Preview", "Message". */
  label: string;
  foot?: ReactNode;
}) {
  const data = Object.entries(message.data);
  return (
    <Paper
      withBorder
      p="sm"
      role="group"
      aria-label={label}
      style={{
        background: "var(--yyt-surface-soft)",
        overflowWrap: "anywhere",
      }}
    >
      {message.title === "" ? (
        <Text size="sm" c="dimmed">
          Data only: the system shows no notification.
        </Text>
      ) : (
        <>
          <Text size="sm" fw={600}>
            {message.title}
          </Text>
          {message.body !== "" && (
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {message.body}
            </Text>
          )}
        </>
      )}
      {data.length > 0 && (
        <Stack gap={2} mt="xs">
          {data.map(([k, v]) => (
            <Code key={k} style={{ whiteSpace: "pre-wrap" }}>
              {k}: {v}
            </Code>
          ))}
        </Stack>
      )}
      {foot}
    </Paper>
  );
}

/**
 * The variables a message names, a sample value for each, and the message a
 * row with those values would be sent as.
 */
export function MessagePreview({
  text,
  samples,
  onSamples,
}: {
  text: PushMessageText;
  samples: Record<string, string>;
  onSamples: (next: Record<string, string>) => void;
}) {
  const vars = templateVars(text);
  const preview = previewMessage(text, samples);
  const over = preview.bytes > PAYLOAD_MAX_BYTES;
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        Variables
      </Text>
      {vars.length === 0 ? (
        <Text size="sm" c="dimmed">
          None: every recipient gets the same text, and a broadcast may use it.
        </Text>
      ) : (
        <>
          <Text size="sm" c="dimmed">
            The CSV needs a column for each: <VarCodes names={vars} />
          </Text>
          {vars.map((v) => (
            <TextInput
              key={v}
              size="xs"
              label={`Sample ${v}`}
              value={samples[v] ?? ""}
              onChange={(e) =>
                onSamples({ ...samples, [v]: e.currentTarget.value })
              }
            />
          ))}
        </>
      )}
      <MessageBox
        message={preview.message}
        label="Preview"
        foot={
          <Text size="xs" c={over ? "red" : "dimmed"} mt="xs">
            {preview.bytes.toLocaleString("en-US")} /{" "}
            {PAYLOAD_MAX_BYTES.toLocaleString("en-US")} bytes
            {over && " — a row this long is skipped (too-large)"}
            {preview.missing.length > 0 &&
              " · a row with an empty variable is skipped"}
          </Text>
        }
      />
    </Stack>
  );
}

/** Priority, time to live and collapse key, folded away until asked for. */
export function AdvancedOptions({
  form,
  onChange,
  problems,
}: {
  form: OptionsForm;
  onChange: (next: OptionsForm) => void;
  problems: { ttlSec?: string; collapseKey?: string };
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const Icon = open ? IconChevronDown : IconChevronRight;
  return (
    <Box>
      <UnstyledButton
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: "var(--mantine-font-size-sm)",
          fontWeight: 500,
          paddingBlock: 4,
        }}
      >
        <Icon size={16} aria-hidden="true" />
        Advanced options
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap="sm" mt="xs" id={id}>
          <NativeSelect
            label="Priority"
            value={form.priority}
            data={[
              { value: "", label: "FCM default" },
              { value: "high", label: "high" },
              { value: "normal", label: "normal" },
            ]}
            onChange={(e) =>
              onChange({
                ...form,
                priority: e.currentTarget.value as OptionsForm["priority"],
              })
            }
          />
          <NumberInput
            label="Time to live (seconds)"
            description="How long FCM keeps the message for a device that is offline. Empty: FCM's default."
            value={form.ttlSec}
            onChange={(ttlSec) => onChange({ ...form, ttlSec })}
            allowDecimal={false}
            allowNegative={false}
            hideControls
            error={problems.ttlSec}
          />
          <TextInput
            label="Collapse key"
            description="Messages with the same key replace each other on a device. Set it when a duplicate would hurt."
            value={form.collapseKey}
            onChange={(e) =>
              onChange({ ...form, collapseKey: e.currentTarget.value })
            }
            error={problems.collapseKey}
          />
        </Stack>
      </Collapse>
    </Box>
  );
}

/** The sticky foot of a drawer whose child owns the form (`ResourceDrawer plain`). */
export function DrawerFoot({
  submitLabel,
  busy,
  disabled,
  onCancel,
  before,
}: {
  submitLabel: string;
  busy?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  /** A second, white verb beside the submit (the dry run). */
  before?: ReactNode;
}) {
  return (
    <Box
      py="sm"
      style={{
        position: "sticky",
        bottom: 0,
        background: "var(--yyt-canvas)",
        borderTop: "1px solid var(--yyt-hairline)",
      }}
    >
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {before}
        <Button type="submit" disabled={disabled || busy} loading={busy}>
          {submitLabel}
        </Button>
      </Group>
    </Box>
  );
}
