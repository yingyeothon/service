import { Button } from "@mantine/core";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { api } from "./api";
import { hasRole, useAuth } from "./auth";
import { AppShellLayout, currentPath } from "./components/layout";
import { Notice, Spinner } from "./components/ui";
import { navMinRole } from "./navigation";
import { ROUTES } from "./routes";
import type { Role } from "./types";

export { currentPath };

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
          ? "Your account is waiting for an admin to approve it. Teams and channels unlock after approval; API tokens and hackathon events are available now."
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
        {ROUTES.map((r) => (
          <Route
            key={r.path}
            path={r.path}
            element={
              r.guard === null ? (
                r.element
              ) : (
                <RequireRole min={navMinRole(r.guard)}>{r.element}</RequireRole>
              )
            }
          />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShellLayout>
  );
}
