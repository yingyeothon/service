import { Group, Loader, Skeleton, Stack, Text } from "@mantine/core";

/** Inline "still fetching" line for a section or a table body. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <Group gap="xs" role="status" aria-live="polite" my="sm">
      <Loader size="xs" />
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}

/**
 * The body of a page whose header is already on screen: a page never
 * early-returns a spinner before its `PageHeader`.
 */
export function PageSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Stack gap="sm" role="status" aria-label="Loading…" my="md">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={16} width={`${80 - i * 15}%`} />
      ))}
    </Stack>
  );
}
