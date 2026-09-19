import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { LoginAttemptView, Role, UserView } from "@gpa/shared";
import { api, setUnauthorizedHandler } from "./api";

interface AuthState {
  user: UserView | null;
  previousLoginAttempts: LoginAttemptView[];
  loading: boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** UI convenience only - the server enforces every permission itself. */
  can(role: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserView | null>(null);
  const [previousLoginAttempts, setPreviousLoginAttempts] = useState<LoginAttemptView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api.me().then((r) => { setUser(r.user); setPreviousLoginAttempts(r.previous_login_attempts ?? []); })
      .catch(() => { setUser(null); setPreviousLoginAttempts([]); }).finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    setUser(result.user);
    setPreviousLoginAttempts(result.previous_login_attempts ?? []);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setPreviousLoginAttempts([]);
  }, []);

  const can = useCallback((role: Role) => !!user && (role === "operator" || user.role === "admin"), [user]);

  return <AuthContext.Provider value={{ user, previousLoginAttempts, loading, signIn, signOut, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
