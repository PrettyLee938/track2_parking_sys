import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { LoginAttemptView, Role, UserView } from "@gpa/shared";
import { api, setUnauthorizedHandler } from "./api";

interface AuthState {
  user: UserView | null;
  previousAttempts: LoginAttemptView[];
  loading: boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** UI convenience only - the server enforces every permission itself. */
  can(role: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserView | null>(null);
  const [previousAttempts, setPreviousAttempts] = useState<LoginAttemptView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setPreviousAttempts([]); });
    api.me().then(async (r) => {
      setUser(r.user);
      setPreviousAttempts((await api.loginAttempts()).items);
    }).catch(() => { setUser(null); setPreviousAttempts([]); }).finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    setUser(result.user);
    setPreviousAttempts(result.previous_attempts);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setPreviousAttempts([]);
  }, []);

  // Admin is the UI superuser; the other roles are separate capabilities.
  // In particular, Maintenance must not inherit Operator traffic controls.
  const can = useCallback((role: Role) => !!user && (user.role === "admin" || user.role === role), [user]);

  return <AuthContext.Provider value={{ user, previousAttempts, loading, signIn, signOut, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
