import { Button } from "@mantine/core";
import { useRef, type ChangeEvent } from "react";

/**
 * The hidden `<input type="file">` plus the button that clicks it, for fields
 * that pick files without a drop target (the screenshot field, the poster
 * button in `EventDetail`). The click-or-drop uploaders share `DropZone` in
 * `ui.tsx` instead.
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
