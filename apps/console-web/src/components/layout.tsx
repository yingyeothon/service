import {
  Anchor,
  AppShell,
  Box,
  Badge,
  Burger,
  Button,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconLogout, IconUser } from "@tabler/icons-react";
import { useCallback, type ReactNode } from "react";
import { NavLink as RouterNavLink, useLocation } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { NAV_ITEMS, isNavActive } from "../navigation";

/** `next` for the login redirect: the SPA path (without the `/ui` base). */
export function currentPath(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}` || "/";
}

const NAVBAR_WIDTH = 220;

function SideNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const { me } = useAuth();
  const location = useLocation();
  return (
    <ScrollArea>
      <Stack gap={0} p="xs" component="nav" aria-label="Main">
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
            leftSection={<item.icon size={18} />}
            active={isNavActive(location.pathname, item.path)}
            onClick={onNavigate}
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
    <Group h="100%" px="md" justify="space-between">
      <Group gap="sm">
        <Burger
          opened={opened}
          onClick={toggle}
          size="sm"
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
            <Title order={4}>yyt console</Title>
          </Group>
        </Anchor>
      </Group>
      {loading ? null : me ? (
        <Menu position="bottom-end">
          <Menu.Target>
            <Button variant="subtle" leftSection={<IconUser size={16} />}>
              {me.login}{" "}
              <Badge ml={6} size="xs" variant="light">
                {me.role}
              </Badge>
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconLogout size={14} />}
              color="red"
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
  const theme = useMantineTheme();
  // Mobile: closed by default / desktop: open by default.
  const [mobileOpened, { toggle: toggleMobile, close: closeMobile }] =
    useDisclosure(false);
  const [desktopOpened, { toggle: toggleDesktop }] = useDisclosure(true);
  const isMobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm})`);
  const opened = isMobile ? mobileOpened : desktopOpened;

  const handleToggle = useCallback(() => {
    (isMobile ? toggleMobile : toggleDesktop)();
  }, [isMobile, toggleMobile, toggleDesktop]);
  const handleNavigate = useCallback(() => {
    if (isMobile) closeMobile();
  }, [isMobile, closeMobile]);

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{
        width: NAVBAR_WIDTH,
        breakpoint: "sm",
        collapsed: { mobile: !mobileOpened, desktop: !desktopOpened },
      }}
      padding="md"
    >
      <AppShell.Header>
        <HeaderBar opened={opened} toggle={handleToggle} />
      </AppShell.Header>
      <AppShell.Navbar>
        <SideNavigation onNavigate={handleNavigate} />
      </AppShell.Navbar>
      <AppShell.Main>
        <Box maw={960} mx="auto">
          {children}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
