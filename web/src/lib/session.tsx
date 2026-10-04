/**
 * Who is using the UI: a demo-login user token (localStorage, so it survives reloads) and,
 * separately, an admin key for creating shows (sessionStorage only: gone when the tab closes).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { post, type Session } from "./api";

const SESSION_KEY = "fdfs.session";
const ADMIN_KEY = "fdfs.admin";

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s.token === "string" && s.expiresAt > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

function store(key: string, value: string | null, storage: () => Storage): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Private mode / blocked storage: the session simply doesn't persist.
  }
}

type SessionContextValue = {
  session: Session | null;
  signIn(username: string): Promise<Session>;
  signOut(): void;
  adminKey: string | null;
  setAdminKey(key: string | null): void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readSession);
  const [adminKey, setAdminKeyState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ADMIN_KEY);
    } catch {
      return null;
    }
  });

  const signIn = useCallback(async (username: string) => {
    const res = await post<{ token: string; user_id: string; expires_in: number }>("/auth/login", {
      username,
    });
    const s: Session = {
      token: res.token,
      userId: res.user_id,
      expiresAt: Date.now() + res.expires_in * 1000,
    };
    store(SESSION_KEY, JSON.stringify(s), () => localStorage);
    setSession(s);
    return s;
  }, []);

  const signOut = useCallback(() => {
    store(SESSION_KEY, null, () => localStorage);
    setSession(null);
  }, []);

  const setAdminKey = useCallback((key: string | null) => {
    store(ADMIN_KEY, key, () => sessionStorage);
    setAdminKeyState(key);
  }, []);

  const value = useMemo(
    () => ({ session, signIn, signOut, adminKey, setAdminKey }),
    [session, signIn, signOut, adminKey, setAdminKey],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
