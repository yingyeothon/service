import { Box, Group, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A titled block of a page. Sections stack with a hairline between them
 * (`.yyt-section + .yyt-section`), so a page is never a pile of cards. The
 * heading is the page's `h2`; actions on the right are default buttons.
 */
export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Box component="section" className="yyt-section" mb="xl" id={id}>
      <Group justify="space-between" align="flex-start" mb="sm" wrap="wrap">
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Title order={2}>{title}</Title>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </Stack>
        {actions && (
          <Group gap="xs" wrap="wrap">
            {actions}
          </Group>
        )}
      </Group>
      {children}
    </Box>
  );
}
