import { Select } from "@mantine/core";
import type { ShowSubmittable, ShowTargetKind } from "../types";

const KIND_LABEL: Record<ShowTargetKind, string> = {
  app: "App",
  bundle: "Asset bundle",
  site: "Site",
};

export const targetValue = (kind: ShowTargetKind, id: string) =>
  `${kind}:${id}`;

/**
 * What the caller may still exhibit, grouped by kind. Used only when
 * submitting: an entry's target is fixed once it is up, and moving the
 * exhibited *build* forward is `yyt show entries update --build` (decision 5).
 * If a target picker is ever added to the edit form it must carry a synthetic
 * option for the entry's current target, or fixing a typo in the title would
 * silently move the entry to whatever the picker defaulted to.
 */
export function TargetPicker({
  targets,
  value,
  disabled,
  onChange,
}: {
  targets: ShowSubmittable[];
  value: string | null;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const all = targets;
  const data = (["app", "bundle", "site"] as const)
    .map((kind) => ({
      group: KIND_LABEL[kind],
      items: all
        .filter((t) => t.kind === kind)
        .map((t) => ({ value: targetValue(t.kind, t.id), label: t.name })),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <Select
      label="What are you exhibiting?"
      placeholder={
        data.length === 0 ? "Nothing left to submit" : "Pick a deliverable"
      }
      data={data}
      value={value}
      disabled={disabled || data.length === 0}
      onChange={onChange}
      searchable
    />
  );
}
