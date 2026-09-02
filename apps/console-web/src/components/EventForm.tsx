import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import {
  buildEventInput,
  DURATION_HOURS_MAX,
  OPTIONS_MAX,
  type EventFormState,
} from "../lib/eventForm";
import type { EventInput } from "../types";
import { MdField } from "./MdField";
import { FormFooter } from "./ResourceDrawer";
import { Notice } from "./ui";

/**
 * Draft form (create) and page editor (edit). `schedule` is true only while
 * the event is a draft: after `publish` the vote deadline, the candidate
 * dates and the duration are frozen (docs/decisions.md *Hackathon workflow*).
 */
export function EventForm({
  initial,
  schedule,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: EventFormState;
  schedule: boolean;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: EventInput | Partial<EventInput>) => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof EventFormState>(k: K, v: EventFormState[K]) =>
    setF((s) => ({ ...s, [k]: v }));
  const setOption = (i: number, v: string) =>
    setF((s) => ({
      ...s,
      options: s.options.map((o, j) => (j === i ? v : o)),
    }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { input, error } = buildEventInput(f, schedule);
    setError(error);
    if (error) return;
    await onSubmit(input);
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Stack gap="md">
        {error && <Notice kind="error">{error}</Notice>}
        <TextInput
          label="Title"
          value={f.title}
          onChange={(e) => set("title", e.target.value)}
          required
          maxLength={200}
          autoComplete="off"
          data-autofocus
        />
        <Group grow align="start">
          <TextInput
            label="Place"
            value={f.place}
            onChange={(e) => set("place", e.target.value)}
            required
            maxLength={200}
          />
          <TextInput
            label="Map link (optional)"
            placeholder="https://"
            value={f.placeUrl}
            onChange={(e) => set("placeUrl", e.target.value)}
            maxLength={1000}
          />
        </Group>
        {schedule && (
          <>
            <Group grow align="start">
              <NumberInput
                label="Duration (hours)"
                value={f.durationHours}
                onChange={(v) =>
                  set("durationHours", typeof v === "number" ? v : 0)
                }
                min={1}
                max={DURATION_HOURS_MAX}
                required
              />
              <TextInput
                type="datetime-local"
                label="Vote until"
                value={f.voteUntil}
                onChange={(e) => set("voteUntil", e.target.value)}
                required
              />
            </Group>
            <div>
              <Text size="sm" fw={500}>
                Candidate dates{" "}
                <Text span size="xs" c="dimmed">
                  (start time, one event per calendar day platform-wide; up to{" "}
                  {OPTIONS_MAX})
                </Text>
              </Text>
              <Stack gap={4} mt={4}>
                {f.options.map((o, i) => (
                  <Group key={i} gap="xs" wrap="nowrap">
                    <TextInput
                      type="datetime-local"
                      aria-label={`Candidate date ${i + 1}`}
                      value={o}
                      onChange={(e) => setOption(i, e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Remove candidate ${i + 1}`}
                      disabled={f.options.length === 1}
                      onClick={() =>
                        set(
                          "options",
                          f.options.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <IconX size={16} aria-hidden="true" />
                    </ActionIcon>
                  </Group>
                ))}
                {f.options.length < OPTIONS_MAX && (
                  <Button
                    size="compact-sm"
                    variant="default"
                    leftSection={<IconPlus size={14} aria-hidden="true" />}
                    onClick={() => set("options", [...f.options, ""])}
                    style={{ alignSelf: "start" }}
                  >
                    Add date
                  </Button>
                )}
              </Stack>
            </div>
          </>
        )}
        <MdField
          label="Description"
          value={f.bodyMd}
          onChange={(v) => set("bodyMd", v)}
        />
        <FormFooter submitLabel={submitLabel} busy={busy} onCancel={onCancel} />
      </Stack>
    </form>
  );
}
