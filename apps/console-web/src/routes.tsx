import type { ReactElement } from "react";
import { Navigate } from "react-router";
import { AssetBundlePage } from "./pages/AssetBundle";
import { CatalogAppPage } from "./pages/CatalogApp";
import { ChannelDetailPage } from "./pages/ChannelDetail";
import { ChannelNewPage } from "./pages/ChannelNew";
import { ChannelsPage } from "./pages/Channels";
import { DiscussionPage } from "./pages/Discussion";
import { EventDetailPage } from "./pages/EventDetail";
import { EventsPage } from "./pages/Events";
import { HomePage } from "./pages/Home";
import { InstallerPage } from "./pages/Installer";
import { IssuePage } from "./pages/Issue";
import { MembersPage } from "./pages/Members";
import { ProjectPage } from "./pages/Project";
import { TeamPage } from "./pages/Team";
import { TeamsPage } from "./pages/Teams";
import { TokensPage } from "./pages/Tokens";

export interface AppRoute {
  path: string;
  /** The NAV_ITEMS path whose `minRole` guards this route; `null` = public. */
  guard: string | null;
  element: ReactElement;
}

/**
 * One table for every route, so a test can prove each guarded path names a
 * navigation item (`navMinRole` throws otherwise — at render time, on the
 * user's screen, which is the wrong place to learn it).
 */
export const ROUTES: AppRoute[] = [
  { path: "/", guard: null, element: <HomePage /> },
  { path: "/events", guard: null, element: <EventsPage /> },
  { path: "/events/:id", guard: null, element: <EventDetailPage /> },
  { path: "/teams", guard: "/teams", element: <TeamsPage /> },
  { path: "/teams/:team", guard: "/teams", element: <TeamPage /> },
  { path: "/teams/:team/:tab", guard: "/teams", element: <TeamPage /> },
  {
    path: "/teams/:team/discussions/:id",
    guard: "/teams",
    element: <DiscussionPage />,
  },
  {
    path: "/teams/:team/projects/:prj",
    guard: "/teams",
    element: <ProjectPage />,
  },
  {
    path: "/teams/:team/projects/:prj/:tab",
    guard: "/teams",
    element: <ProjectPage />,
  },
  {
    path: "/teams/:team/projects/:prj/channels/new",
    guard: "/channels",
    element: <ChannelNewPage />,
  },
  {
    path: "/teams/:team/projects/:prj/issues/:n",
    guard: "/teams",
    element: <IssuePage />,
  },
  { path: "/channels", guard: "/channels", element: <ChannelsPage /> },
  { path: "/channels/:id", guard: "/channels", element: <ChannelDetailPage /> },
  // Apps and bundles are listed per project now; the old list paths land on Teams.
  {
    path: "/catalog",
    guard: "/catalog",
    element: <Navigate to="/teams" replace />,
  },
  { path: "/catalog/apps/:id", guard: "/catalog", element: <CatalogAppPage /> },
  {
    path: "/assets",
    guard: "/assets",
    element: <Navigate to="/teams" replace />,
  },
  { path: "/assets/:id", guard: "/assets", element: <AssetBundlePage /> },
  { path: "/installer", guard: "/installer", element: <InstallerPage /> },
  { path: "/tokens", guard: "/tokens", element: <TokensPage /> },
  { path: "/members", guard: "/members", element: <MembersPage /> },
];
