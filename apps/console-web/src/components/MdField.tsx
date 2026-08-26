import { Button, Group, Paper, Text, Textarea } from "@mantine/core";
import { useState } from "react";
import { Markdown } from "./Markdown";

/** A markdown textarea with a preview toggle, rendered through the same sanitizer as the page. */
export function MdField({
  label,
  value,
  onChange,
  maxLength = 20000,
  minRows = 4,
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  minRows?: number;
  required?: boolean;
  placeholder?: string;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div>
      <Group justify="space-between" align="end" mb={4}>
        <Text size="sm" fw={500}>
          {label}{" "}
          <Text span size="xs" c="dimmed">
            (Markdown; no HTML, no images)
          </Text>
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => setPreview((v) => !v)}
        >
          {preview ? "Edit" : "Preview"}
        </Button>
      </Group>
      {preview ? (
        <Paper withBorder p="sm" mih={80}>
          <Markdown text={value} />
          {value.trim() === "" && (
            <Text size="sm" c="dimmed">
              Nothing to preview.
            </Text>
          )}
        </Paper>
      ) : (
        <Textarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          autosize
          minRows={minRows}
          required={required}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}
