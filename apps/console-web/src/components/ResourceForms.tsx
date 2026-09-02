import { Button, Card, Group, Stack, TextInput } from "@mantine/core";
import type { FormEvent, ReactNode } from "react";
import { MdField } from "./MdField";
import { FormActions } from "./ui";

/*
 * The two name/description edit cards the resource pages share: the inline
 * one on a bundle or site page (plain description field) and the stacked one
 * on a project or team settings tab (markdown description, name required).
 */

export interface NameDescriptionProps {
  name: string;
  description: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onSubmit: (e: FormEvent) => Promise<void>;
  busy: boolean;
}

export function ResourceInfoForm({
  name,
  description,
  onName,
  onDescription,
  onSubmit,
  busy,
}: NameDescriptionProps) {
  return (
    <Card withBorder mb="md" padding="sm">
      <form onSubmit={(e) => void onSubmit(e)}>
        <Group align="end" wrap="wrap">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => onName(e.target.value)}
            maxLength={64}
            w={200}
          />
          <TextInput
            label="Description"
            value={description}
            onChange={(e) => onDescription(e.target.value)}
            maxLength={2000}
            w={280}
          />
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </Group>
      </form>
    </Card>
  );
}

export function SettingsForm({
  name,
  description,
  onName,
  onDescription,
  onSubmit,
  busy,
}: NameDescriptionProps) {
  return (
    <Card withBorder mb="md" padding="sm">
      <form onSubmit={(e) => void onSubmit(e)}>
        <Stack gap="xs">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => onName(e.target.value)}
            required
            maxLength={64}
          />
          <MdField
            label="Description"
            value={description}
            onChange={onDescription}
          />
          <Group>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

/**
 * A title + markdown body draft (new or edited discussion, new or edited
 * issue). `extra` sits between the two for a picker the entity needs, such
 * as an issue's version.
 */
export function DraftForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  bodyLabel,
  busy,
  extra,
}: {
  draft: { title: string; bodyMd: string };
  onChange: (next: { title: string; bodyMd: string }) => void;
  onSubmit: (e: FormEvent) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
  bodyLabel: string;
  busy: boolean;
  extra?: ReactNode;
}) {
  return (
    <Card withBorder mb="md" padding="sm">
      <form onSubmit={(e) => void onSubmit(e)}>
        <Stack gap="xs">
          <TextInput
            label="Title"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            required
            maxLength={200}
          />
          {extra}
          <MdField
            label={bodyLabel}
            value={draft.bodyMd}
            onChange={(bodyMd) => onChange({ ...draft, bodyMd })}
          />
          <FormActions
            submitLabel={submitLabel}
            disabled={busy || !draft.title.trim()}
            onCancel={onCancel}
          />
        </Stack>
      </form>
    </Card>
  );
}
