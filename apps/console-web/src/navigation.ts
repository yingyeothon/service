import {
  IconCalendarEvent,
  IconDeviceMobileDown,
  IconHome,
  IconKey,
  IconPackages,
  IconPhoto,
  IconUsers,
  IconUsersGroup,
  IconWorld,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { Role } from "./types";

export type NavIcon = ComponentType<IconProps>;

export interface NavItem {
  path: string;
  label: string;
  icon: NavIcon;
  /**
   * Minimum role to see the item; `null` = public, `"pending"` = any signed-in
   * user. The same config drives both the menu and the route guards, so the
   * two can never disagree.
   */
  minRole: Role | null;
  /**
   * Kept out of the menu but still the guard for its routes: resources are
   * reached through their project since todo/17, yet the cross-team lists and
   * the detail pages keep their paths (bookmarks, CLI output).
   */
  hidden?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Home", icon: IconHome, minRole: null },
  { path: "/events", label: "Events", icon: IconCalendarEvent, minRole: null },
  { path: "/teams", label: "Teams", icon: IconUsersGroup, minRole: "member" },
  {
    path: "/channels",
    label: "Channels",
    icon: IconWorld,
    minRole: "member",
    hidden: true,
  },
  {
    path: "/catalog",
    label: "Catalog",
    icon: IconPackages,
    minRole: "member",
    hidden: true,
  },
  {
    path: "/assets",
    label: "Assets",
    icon: IconPhoto,
    minRole: "member",
    hidden: true,
  },
  {
    path: "/installer",
    label: "Installer",
    icon: IconDeviceMobileDown,
    minRole: "member",
  },
  { path: "/tokens", label: "API tokens", icon: IconKey, minRole: "pending" },
  { path: "/members", label: "Members", icon: IconUsers, minRole: "admin" },
];

export const isNavActive = (pathname: string, path: string): boolean =>
  path === "/"
    ? pathname === "/"
    : pathname === path || pathname.startsWith(`${path}/`);

/**
 * Route guards read the same navigation config that renders the menu, so the
 * two can never disagree. Guarded paths must exist in NAV_ITEMS with a role.
 */
export function navMinRole(path: string): Role {
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (!item || item.minRole === null)
    throw new Error(`no guarded nav item for ${path}`);
  return item.minRole;
}
