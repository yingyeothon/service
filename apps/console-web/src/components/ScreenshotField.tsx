import { Group, Image, Paper, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { ShowShot } from "../types";
import { Button } from "@mantine/core";
import { FilePicker } from "./FilePicker";

export const SHOTS_MAX = 3;

interface Picked {
  file: File;
  /** An object URL; revoked on unmount, or the form leaks megabytes. */
  preview: string;
}

/**
 * At most three screenshots, replaced wholesale: what the field shows is what
 * the entry will have. Existing shots can be dropped and new files added, and
 * `onSave` is handed both halves — the API commits one list, so there is no
 * half-replaced state to reconcile.
 */
export function ScreenshotField({
  shots,
  disabled,
  onSave,
}: {
  shots: ShowShot[];
  disabled?: boolean;
  /** Resolves falsy when the save failed, so the picked files are kept. */
  onSave: (keep: ShowShot[], added: File[]) => Promise<unknown>;
}) {
  const [keep, setKeep] = useState<ShowShot[]>(shots);
  const [added, setAdded] = useState<Picked[]>([]);

  // Reset only when the *set* of live shots actually changes — the entry
  // refetches after a like or a comment, and a fresh array with the same ids
  // must not silently undo a removal the user is in the middle of.
  // `shots` is a new array on every refetch; its ids are the identity, so a
  // ref carries the value while the key decides when to reset.
  const liveKey = shots.map((s) => s.id).join(",");
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  useEffect(() => {
    setKeep(shotsRef.current);
  }, [liveKey]);

  // Revoke on unmount only. A `[added]` dependency would run the *previous*
  // cleanup on every add, revoking a preview that is still on screen.
  const live = useRef<Picked[]>([]);
  live.current = added;
  useEffect(
    () => () => {
      for (const p of live.current) URL.revokeObjectURL(p.preview);
    },
    [],
  );

  const total = keep.length + added.length;
  const room = Math.max(0, SHOTS_MAX - total);
  const dirty =
    added.length > 0 ||
    keep.length !== shots.length ||
    keep.some((k, i) => k.id !== shots[i]?.id);

  const drop = (id: string) => setKeep((ks) => ks.filter((k) => k.id !== id));
  const undo = (preview: string) =>
    setAdded((ps) => {
      URL.revokeObjectURL(preview);
      return ps.filter((p) => p.preview !== preview);
    });

  return (
    <Stack gap="xs">
      <Group gap="xs" align="flex-start">
        {keep.map((s) => (
          <Paper key={s.id} withBorder p={4}>
            <Stack gap={4} align="center">
              <Image src={s.url} h={80} w={120} fit="contain" alt="" />
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                disabled={disabled}
                onClick={() => drop(s.id)}
              >
                Remove
              </Button>
            </Stack>
          </Paper>
        ))}
        {added.map((p) => (
          <Paper key={p.preview} withBorder p={4}>
            <Stack gap={4} align="center">
              <Image src={p.preview} h={80} w={120} fit="contain" alt="" />
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                disabled={disabled}
                onClick={() => undo(p.preview)}
              >
                Undo
              </Button>
            </Stack>
          </Paper>
        ))}
      </Group>
      <Group gap="xs">
        <FilePicker
          label={`Add screenshot${room === 1 ? "" : "s"}`}
          accept="image/png,image/jpeg"
          multiple
          disabled={disabled || room === 0}
          onPick={(files) =>
            setAdded((ps) => [
              ...ps,
              ...files.slice(0, room).map((file) => ({
                file,
                preview: URL.createObjectURL(file),
              })),
            ])
          }
        />
        <Button
          size="compact-sm"
          disabled={disabled || !dirty}
          onClick={() =>
            void (async () => {
              // Only clear the staged files when the save actually landed:
              // otherwise a failed upload silently throws away what the user
              // picked and leaves nothing but a red notice.
              if (
                !(await onSave(
                  keep,
                  added.map((p) => p.file),
                ))
              )
                return;
              for (const p of added) URL.revokeObjectURL(p.preview);
              setAdded([]);
            })()
          }
        >
          Save screenshots
        </Button>
        <Text size="xs" c="dimmed">
          {total}/{SHOTS_MAX} · png or jpeg, 5 MB each
        </Text>
      </Group>
    </Stack>
  );
}
