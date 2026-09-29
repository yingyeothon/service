import { NativeSelect, Stack, TextInput } from "@mantine/core";
import type { ReactNode } from "react";
import type { Version } from "../types";
import { MdField } from "./MdField";

/** Title + markdown body: a discussion or an issue draft. */
export function DiscussionFields({
  title,
  bodyMd,
  onChange,
  bodyLabel = "Body",
  extra,
}: {
  title: string;
  bodyMd: string;
  onChange: (p: { title?: string; bodyMd?: string }) => void;
  bodyLabel?: string;
  extra?: ReactNode;
}) {
  return (
    <Stack gap="md">
      <TextInput
        label="Title"
        value={title}
        onChange={(e) => onChange({ title: e.currentTarget.value })}
        required
        maxLength={200}
        autoComplete="off"
        data-autofocus
      />
      {extra}
      <MdField
        label={bodyLabel}
        value={bodyMd}
        onChange={(bodyMd) => onChange({ bodyMd })}
      />
    </Stack>
  );
}

/** Version picker shared by the issue form and the issue page. */
export function VersionSelect({
  versions,
  value,
  onChange,
  label = "Version",
}: {
  versions: Version[];
  value: string | null;
  onChange: (v: string | null) => void;
  label?: string;
}) {
  return (
    <NativeSelect
      label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      data={[
        { value: "", label: "— none —" },
        ...versions.map((v) => ({ value: v.id, label: v.name })),
        // A preset the list does not (yet) carry keeps its own option: a
        // native select with no matching option would show "none" while
        // the form still holds the id.
        ...(value && !versions.some((v) => v.id === value)
          ? [{ value, label: value }]
          : []),
      ]}
    />
  );
}
