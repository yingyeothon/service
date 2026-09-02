import { Paper, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

/** A surface-soft panel with one sentence and, when allowed, the way out. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Paper p="xl" bg="var(--yyt-surface-soft)" withBorder={false}>
      <Stack gap="xs" align="center" ta="center">
        <Text size="sm">{title}</Text>
        {hint && (
          <Text size="sm" c="dimmed">
            {hint}
          </Text>
        )}
        {action}
      </Stack>
    </Paper>
  );
}
