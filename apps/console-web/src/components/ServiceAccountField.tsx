import { Group, Stack, Text, TextInput } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { SERVICE_ACCOUNT_MAX } from "../lib/push";
import { FilePicker } from "./FilePicker";

/** `FileReader` rather than `File.text()`, which jsdom does not implement. */
const readText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsText(file);
  });

/**
 * The write-only field for a Firebase service-account key: pasted, or read
 * from the key file. The value is masked like every other secret field and
 * never rendered back; a picked file is acknowledged by its length only (a
 * key file's name carries the Firebase project id).
 */
export function ServiceAccountField({
  value,
  onChange,
  error,
  description,
  label = "Service-account key (JSON)",
}: {
  value: string;
  onChange: (key: string) => void;
  error?: string | null;
  description?: ReactNode;
  label?: string;
}) {
  // What the picker last did; cleared as soon as the value is typed over.
  const [picked, setPicked] = useState<
    { ok: true; chars: number } | { ok: false; message: string } | null
  >(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    // A key file is ~2.4 kB; anything far past the cap is the wrong file.
    if (file.size > SERVICE_ACCOUNT_MAX) {
      setPicked({
        ok: false,
        message:
          "That file is larger than a service-account key file (16 KiB).",
      });
      return;
    }
    try {
      const text = (await readText(file)).trim();
      onChange(text);
      setPicked({ ok: true, chars: text.length });
    } catch {
      setPicked({ ok: false, message: "That file could not be read." });
    }
  };
  return (
    <Stack gap={6}>
      <TextInput
        label={label}
        description={description}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setPicked(null);
          onChange(e.target.value);
        }}
        error={error ?? undefined}
        required
        placeholder="paste the key file's contents"
      />
      <Group gap="xs" align="center">
        <FilePicker
          label="Choose key file"
          accept=".json,application/json"
          onPick={(files) => void pick(files[0])}
        />
        <Text
          size="sm"
          c={picked?.ok === false ? "red" : "dimmed"}
          role="status"
        >
          {picked === null
            ? "Stored write-only: it is never shown again."
            : picked.ok
              ? `Key file loaded (${picked.chars.toLocaleString("en-US")} characters).`
              : picked.message}
        </Text>
      </Group>
    </Stack>
  );
}
