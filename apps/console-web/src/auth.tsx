import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ApiClient } from "./api";
import type { Me, Role } from "./types";

interface AuthState {
  me: Me | null;
  /** `true` until the first `/me` round-trip finishes. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

const RANK: Record<Role, number> = { pending: 0, member: 1, admin: 2 };
export const hasRole = (me: Me | null, min: Role): boolean =>
  me !== null && RANK[me.role] >= RANK[min];

export function AuthProvider({
  children,
  client = api,
}: {
  children: ReactNode;
  client?: ApiClient;
}) {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await client.me());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // A 401 from any call means the cookie session is gone: drop `me` so
    // guarded pages fall back to the sign-in notice instead of raw errors.
    client.setUnauthorizedHandler(() => {
      setMe(null);
      // The session is gone: drop cached data so nothing from the previous
      // session can be served to a later one.
      queryClient.clear();
    });
    return () => client.setUnauthorizedHandler(undefined);
  }, [client, queryClient]);

  const logout = useCallback(async () => {
    try {
      await client.logout();
    } finally {
      // The cookie is gone or invalid either way.
      setMe(null);
      queryClient.clear();
    }
  }, [client, queryClient]);

  return (
    <AuthContext.Provider value={{ me, loading, error, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
