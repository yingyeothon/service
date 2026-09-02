import {
  ActionIcon,
  Anchor,
  AppShell,
  Avatar,
  Box,
  Burger,
  Button,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLogout } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { NavLink as RouterNavLink, useLocation } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { NAV_ITEMS, isNavActive } from "../navigation";

/** `next` for the login redirect: the SPA path (without the `/ui` base). */
export function currentPath(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}` || "/";
}

/** DESIGN.md `topic-filter-rail` width and `top-nav` height. */
const NAVBAR_WIDTH = 240;
const HEADER_HEIGHT = 64;

function SideNavigation({ onNavigate }: { onNavigate: () => void }) {
  const { me } = useAuth();
  const location = useLocation();
  return (
    <ScrollArea>
      <Stack gap={2} p="sm" component="nav" aria-label="Main">
        {NAV_ITEMS.filter(
          (item) =>
            !item.hidden &&
            (item.minRole === null || hasRole(me, item.minRole)),
        ).map((item) => (
          <NavLink
            key={item.path}
            component={RouterNavLink}
            to={item.path}
            label={item.label}
            leftSection={<item.icon size={18} aria-hidden="true" />}
            active={isNavActive(location.pathname, item.path)}
            onClick={onNavigate}
            variant="light"
            color="ink"
            styles={{
              root: { borderRadius: 6, minHeight: 44 },
              label: { fontSize: 14 },
            }}
          />
        ))}
      </Stack>
    </ScrollArea>
  );
}

function HeaderBar({
  opened,
  toggle,
}: {
  opened: boolean;
  toggle: () => void;
}) {
  const { me, loading, logout } = useAuth();
  const loc = useLocation();
  return (
    <Group h="100%" px="md" justify="space-between" wrap="nowrap">
      <Group gap="sm" wrap="nowrap">
        <Burger
          opened={opened}
          onClick={toggle}
          size="sm"
          hiddenFrom="sm"
          aria-label="Menu"
          aria-expanded={opened}
        />
        <Anchor component={RouterNavLink} to="/" underline="never" c="inherit">
          <Group gap="xs" wrap="nowrap">
            <img
              src={`${import.meta.env.BASE_URL}yyt-logo.png`}
              alt=""
              width={28}
              height={28}
            />
            <Text fw={500} size="lg">
              yyt console
            </Text>
          </Group>
        </Anchor>
      </Group>
      {loading ? null : me ? (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon aria-label={`Account menu for ${me.login}`} size={40}>
              <Avatar radius="xl" size={32} color="ink">
                {me.login.slice(0, 1).toUpperCase()}
              </Avatar>
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>
              {me.login} · {me.role}
            </Menu.Label>
            <Menu.Item
              leftSection={<IconLogout size={14} aria-hidden="true" />}
              onClick={() => void logout()}
            >
              Sign out
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : (
        <Button
          component="a"
          variant="default"
          href={api.loginUrl(currentPath(loc))}
        >
          Sign in
        </Button>
      )}
    </Group>
  );
}

export function AppShellLayout({ children }: { children: ReactNode }) {
  // The navigation is always visible from the `sm` breakpoint up; below it
  // the burger opens it as an overlay that closes after a choice.
  const [opened, { toggle, close }] = useDisclosure(false);
  return (
    <AppShell
      header={{ height: HEADER_HEIGHT }}
      navbar={{
        width: NAVBAR_WIDTH,
        breakpoint: "sm",
        collapsed: { mobile: !opened, desktop: false },
      }}
      padding="lg"
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <AppShell.Header>
        <HeaderBar opened={opened} toggle={toggle} />
      </AppShell.Header>
      <AppShell.Navbar>
        <SideNavigation onNavigate={close} />
      </AppShell.Navbar>
      <AppShell.Main id="main">
        <Box maw={1080} mx="auto">
          {children}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
