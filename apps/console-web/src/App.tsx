import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import { api } from "./api";
import { hasRole, useAuth } from "./auth";
import { Notice, Spinner } from "./components/ui";
import { ChannelDetailPage } from "./pages/ChannelDetail";
import { ChannelNewPage } from "./pages/ChannelNew";
import { ChannelsPage } from "./pages/Channels";
import { EventDetailPage } from "./pages/EventDetail";
import { EventsPage } from "./pages/Events";
import { HomePage } from "./pages/Home";
import { MembersPage } from "./pages/Members";
import { TokensPage } from "./pages/Tokens";
import type { Role } from "./types";

/** `next` for the login redirect: the SPA path (without the `/ui` base). */
export function currentPath(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}` || "/";
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
        <a className="btn btn-primary" href={api.loginUrl(currentPath(loc))}>
          Sign in with GitHub
        </a>
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
  const { me, loading, error, logout, refresh } = useAuth();
  const loc = useLocation();
  return (
    <>
      <header className="top">
        <NavLink to="/" className="brand">
          yyt console
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/events">Events</NavLink>
          {hasRole(me, "member") && <NavLink to="/channels">Channels</NavLink>}
          {me && <NavLink to="/tokens">API tokens</NavLink>}
          {hasRole(me, "admin") && <NavLink to="/members">Members</NavLink>}
        </nav>
        <div className="who">
          {loading ? null : me ? (
            <>
              <span>
                {me.login} <span className="badge">{me.role}</span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void logout()}
              >
                Sign out
              </button>
            </>
          ) : (
            <a className="btn btn-sm" href={api.loginUrl(currentPath(loc))}>
              Sign in
            </a>
          )}
        </div>
      </header>
      <main>
        {error && (
          <Notice kind="error">
            Could not reach the API: {error}{" "}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </Notice>
        )}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/events/:id" element={<EventDetailPage />} />
          <Route
            path="/channels"
            element={
              <RequireRole min="member">
                <ChannelsPage />
              </RequireRole>
            }
          />
          <Route
            path="/channels/new"
            element={
              <RequireRole min="member">
                <ChannelNewPage />
              </RequireRole>
            }
          />
          <Route
            path="/channels/:id"
            element={
              <RequireRole min="member">
                <ChannelDetailPage />
              </RequireRole>
            }
          />
          <Route
            path="/tokens"
            element={
              <RequireRole min="pending">
                <TokensPage />
              </RequireRole>
            }
          />
          <Route
            path="/members"
            element={
              <RequireRole min="admin">
                <MembersPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
