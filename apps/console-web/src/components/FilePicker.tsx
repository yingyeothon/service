import { Button } from "@mantine/core";
import { useRef, type ChangeEvent } from "react";

/**
 * The hidden `<input type="file">` plus the button that clicks it — the shell
 * four uploaders in this app already spell out by hand. Extracted for the
 * screenshot field rather than retrofitted onto them: they each have their own
 * label and busy state, and rewriting four working uploaders to share this
 * would be a change with no user-visible effect.
 */
export function FilePicker({
  label,
  accept,
  multiple,
  disabled,
  onPick,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onPick: (files: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="compact-sm"
        variant="light"
        disabled={disabled}
        onClick={() => ref.current?.click()}
      >
        {label}
      </Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        aria-label={label}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const files = [...(e.currentTarget.files ?? [])];
          // Same file twice in a row must still fire `change`.
          e.currentTarget.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
    </>
  );
}
