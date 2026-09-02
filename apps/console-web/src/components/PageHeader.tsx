import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * One action on a page header. Exactly one may be `primary` (the filled ink
 * button); the others render as white outlined buttons in the order given,
 * except `menu` and `danger` ones, which live in the overflow menu — a
 * destructive verb is never a button in the header.
 */
export interface HeaderAction {
  label: string;
  onClick?: () => void | Promise<void>;
  /** In-app navigation instead of a handler. */
  to?: string;
  /** External navigation (`<a href>`). */
  href?: string;
  primary?: boolean;
  danger?: boolean;
  menu?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}

function ActionButton({ action }: { action: HeaderAction }) {
  const common = {
    variant: action.primary ? "filled" : "default",
    disabled: action.disabled,
    leftSection: action.icon,
    children: action.label,
  } as const;
  if (action.to) return <Button component={Link} to={action.to} {...common} />;
  if (action.href)
    return <Button component="a" href={action.href} {...common} />;
  return <Button onClick={() => void action.onClick?.()} {...common} />;
}

/**
 * The top of every page: the page's only `h1`, its badges, a meta line and
 * the actions. `title` undefined paints a skeleton bar, so the header is on
 * screen before the data is — a page never early-returns a spinner instead.
 */
export function PageHeader({
  title,
  badges,
  meta,
  description,
  actions = [],
  children,
}: {
  title?: string;
  badges?: ReactNode;
  /** Small dimmed line under the title: created by, counts, ids. */
  meta?: ReactNode;
  /** One sentence on what the page is for. */
  description?: ReactNode;
  actions?: HeaderAction[];
  /** Anything else that belongs to the header band (a stepper, a poster). */
  children?: ReactNode;
}) {
  const buttons = actions.filter((a) => !a.menu && !a.danger);
  const overflow = actions.filter((a) => a.menu || a.danger);
  return (
    <Stack gap="xs" mb="lg" component="header">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Group gap="sm" align="center" wrap="wrap" style={{ minWidth: 0 }}>
          {title === undefined ? (
            <Skeleton height={28} width={240} aria-label="Loading…" />
          ) : (
            <Title order={1} style={{ overflowWrap: "anywhere" }}>
              {title}
            </Title>
          )}
          {badges}
        </Group>
        {(buttons.length > 0 || overflow.length > 0) && (
          <Group gap="xs" wrap="wrap">
            {buttons.map((a) => (
              <ActionButton key={a.label} action={a} />
            ))}
            {overflow.length > 0 && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon aria-label="More actions">
                    <IconDots size={18} aria-hidden="true" />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {overflow.map((a) =>
                    a.to ? (
                      <Menu.Item
                        key={a.label}
                        component={Link}
                        to={a.to}
                        disabled={a.disabled}
                      >
                        {a.label}
                      </Menu.Item>
                    ) : (
                      <Menu.Item
                        key={a.label}
                        color={a.danger ? "red" : undefined}
                        disabled={a.disabled}
                        onClick={() => void a.onClick?.()}
                      >
                        {a.label}
                      </Menu.Item>
                    ),
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        )}
      </Group>
      {description && (
        <Text size="sm" c="dimmed" maw={720}>
          {description}
        </Text>
      )}
      {meta && (
        <Text size="sm" c="dimmed" className="tabular">
          {meta}
        </Text>
      )}
      {children}
    </Stack>
  );
}
