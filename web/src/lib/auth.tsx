import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Role, UserView } from "@gpa/shared";
import { api, setUnauthorizedHandler } from "./api";

interface AuthState {
  user: UserView | null;
  loading: boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** UI convenience only - the server enforces every permission itself. */
  can(role: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    setUser((await api.login(username, password)).user);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const can = useCallback((role: Role) => !!user && (role === "operator" || user.role === "admin"), [user]);

  return <AuthContext.Provider value={{ user, loading, signIn, signOut, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
