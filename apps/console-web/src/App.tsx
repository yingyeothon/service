import { Button } from "@mantine/core";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { api } from "./api";
import { hasRole, useAuth } from "./auth";
import { AppShellLayout, currentPath } from "./components/layout";
import { Notice, Spinner } from "./components/ui";
import { NAV_ITEMS } from "./navigation";
import { CatalogPage } from "./pages/Catalog";
import { CatalogAppPage } from "./pages/CatalogApp";
import { CatalogGroupPage } from "./pages/CatalogGroup";
import { ChannelDetailPage } from "./pages/ChannelDetail";
import { ChannelNewPage } from "./pages/ChannelNew";
import { ChannelsPage } from "./pages/Channels";
import { EventDetailPage } from "./pages/EventDetail";
import { EventsPage } from "./pages/Events";
import { HomePage } from "./pages/Home";
import { MembersPage } from "./pages/Members";
import { TokensPage } from "./pages/Tokens";
import type { Role } from "./types";

export { currentPath };

/**
 * Route guards read the same navigation config that renders the menu, so the
 * two can never disagree. Guarded paths must exist in NAV_ITEMS with a role.
 */
function navMinRole(path: string): Role {
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (!item || item.minRole === null)
    throw new Error(`no guarded nav item for ${path}`);
  return item.minRole;
}

function RequireRole({
  min,
  children,
}: {
  min: Role;
  children: React.ReactNode;
}) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me)
    return (
      <Notice>
        <p>Sign in to continue.</p>
        <Button component="a" href={api.loginUrl(currentPath(loc))}>
          Sign in with GitHub
        </Button>
      </Notice>
    );
  if (!hasRole(me, min))
    return (
      <Notice kind="warn">
        {me.role === "pending"
          ? "Your account is waiting for an admin to approve it. Channels unlock after approval; API tokens and hackathon events are available now."
          : `This page requires the ${min} role.`}
      </Notice>
    );
  return <>{children}</>;
}

export function App() {
  const { error, refresh } = useAuth();
  return (
    <AppShellLayout>
      {error && (
        <Notice kind="error">
          Could not reach the API: {error}{" "}
          <Button
            size="compact-sm"
            variant="default"
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </Notice>
      )}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route
          path="/channels"
          element={
            <RequireRole min={navMinRole("/channels")}>
              <ChannelsPage />
            </RequireRole>
          }
        />
        <Route
          path="/channels/new"
          element={
            <RequireRole min={navMinRole("/channels")}>
              <ChannelNewPage />
            </RequireRole>
          }
        />
        <Route
          path="/channels/:id"
          element={
            <RequireRole min={navMinRole("/channels")}>
              <ChannelDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="/catalog"
          element={
            <RequireRole min={navMinRole("/catalog")}>
              <CatalogPage />
            </RequireRole>
          }
        />
        <Route
          path="/catalog/apps/:name"
          element={
            <RequireRole min={navMinRole("/catalog")}>
              <CatalogAppPage />
            </RequireRole>
          }
        />
        <Route
          path="/catalog/groups/:id"
          element={
            <RequireRole min={navMinRole("/catalog")}>
              <CatalogGroupPage />
            </RequireRole>
          }
        />
        <Route
          path="/tokens"
          element={
            <RequireRole min={navMinRole("/tokens")}>
              <TokensPage />
            </RequireRole>
          }
        />
        <Route
          path="/members"
          element={
            <RequireRole min={navMinRole("/members")}>
              <MembersPage />
            </RequireRole>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShellLayout>
  );
}
