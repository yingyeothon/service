import {
  IconCalendarEvent,
  IconHome,
  IconKey,
  IconPackages,
  IconUsers,
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
}

export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Home", icon: IconHome, minRole: null },
  { path: "/events", label: "Events", icon: IconCalendarEvent, minRole: null },
  { path: "/channels", label: "Channels", icon: IconWorld, minRole: "member" },
  { path: "/catalog", label: "Catalog", icon: IconPackages, minRole: "member" },
  { path: "/tokens", label: "API tokens", icon: IconKey, minRole: "pending" },
  { path: "/members", label: "Members", icon: IconUsers, minRole: "admin" },
];

export const isNavActive = (pathname: string, path: string): boolean =>
  path === "/"
    ? pathname === "/"
    : pathname === path || pathname.startsWith(`${path}/`);
