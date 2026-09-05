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
import { KvCollectionPage } from "./pages/KvCollection";
import { VersionPage } from "./pages/Version";
import { MembersPage } from "./pages/Members";
import { ProjectPage } from "./pages/Project";
import { SitePage } from "./pages/Site";
import { TeamPage } from "./pages/Team";
import { TeamsPage } from "./pages/Teams";
import { TokensPage } from "./pages/Tokens";
import { AppLoginPage } from "./pages/AppLogin";
import { AuditPage } from "./pages/Audit";
import { ShowDetailPage } from "./pages/ShowDetail";
import { ShowEntryPage } from "./pages/ShowEntry";
import { ShowsPage } from "./pages/Shows";

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
  // Public, exactly like `/events`: the show's own ACL decides, per request.
  { path: "/shows", guard: null, element: <ShowsPage /> },
  { path: "/shows/:id", guard: null, element: <ShowDetailPage /> },
  // Submitting and editing are inline forms on these two pages rather than
  // routes of their own; that is a UX choice, not a way to hide anything.
  {
    path: "/shows/:id/entries/:eid",
    guard: null,
    element: <ShowEntryPage />,
  },
  { path: "/audit", guard: "/audit", element: <AuditPage /> },
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
    guard: "/teams",
    element: <ChannelNewPage />,
  },
  {
    path: "/teams/:team/projects/:prj/issues/:n",
    guard: "/teams",
    element: <IssuePage />,
  },
  {
    path: "/teams/:team/projects/:prj/versions/:ver",
    guard: "/teams",
    element: <VersionPage />,
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
  {
    path: "/sites",
    guard: "/sites",
    element: <Navigate to="/teams" replace />,
  },
  { path: "/sites/:id", guard: "/sites", element: <SitePage /> },
  {
    path: "/kv",
    guard: "/kv",
    element: <Navigate to="/teams" replace />,
  },
  { path: "/kv/:id", guard: "/kv", element: <KvCollectionPage /> },
  { path: "/installer", guard: "/installer", element: <InstallerPage /> },
  { path: "/tokens", guard: "/tokens", element: <TokensPage /> },
  { path: "/app-login", guard: "/app-login", element: <AppLoginPage /> },
  { path: "/members", guard: "/members", element: <MembersPage /> },
];
