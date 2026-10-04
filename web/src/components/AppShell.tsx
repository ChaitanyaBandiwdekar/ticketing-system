import type { ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useReadiness } from "../lib/queries";
import { useSession } from "../lib/session";
import { Button, buttonClass, cx } from "./ui";

export function Wordmark() {
  return (
    <Link
      to="/shows"
      className="group flex items-center gap-2.5 rounded-md text-ink"
      aria-label="FirstDayFirstShow, all shows"
    >
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="7" className="fill-surface-2" />
        <path
          d="M6 11c6-3.2 14-3.2 20 0"
          className="stroke-primary-ink"
          strokeWidth="2.6"
          fill="none"
          strokeLinecap="round"
        />
        <g className="fill-seat-free">
          <rect x="7" y="16" width="5" height="4.5" rx="1.2" />
          <rect x="13.5" y="16" width="5" height="4.5" rx="1.2" />
          <rect x="20" y="16" width="5" height="4.5" rx="1.2" />
          <rect x="7" y="22" width="5" height="4.5" rx="1.2" />
          <rect x="20" y="22" width="5" height="4.5" rx="1.2" />
        </g>
        <rect x="13.5" y="22" width="5" height="4.5" rx="1.2" className="fill-amber" />
      </svg>
      {/* The name yields to the nav on the narrowest phones; the link keeps its aria-label. */}
      <span className="hidden items-baseline gap-2 min-[420px]:flex">
        <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">FirstDayFirstShow</span>
        <span className="hidden font-mono text-xs text-muted sm:inline">FDFS</span>
      </span>
    </Link>
  );
}

function Readiness() {
  const { data } = useReadiness();
  const state = data ?? "checking";
  const meta = {
    ready: { dot: "bg-success", text: "Box office open", title: "GET /readyz: 200" },
    unavailable: {
      dot: "bg-amber",
      text: "Database unavailable",
      title: "GET /readyz: 503. Reservations fail closed until it recovers.",
    },
    offline: { dot: "bg-danger", text: "Server unreachable", title: "GET /readyz: no response" },
    checking: { dot: "bg-line-strong", text: "Checking…", title: "GET /readyz" },
  }[state];
  return (
    <span
      className="hidden items-center gap-2 text-xs whitespace-nowrap text-muted lg:inline-flex"
      title={meta.title}
      role="status"
    >
      <span className={cx("size-1.5 rounded-full", meta.dot)} aria-hidden />
      {meta.text}
    </span>
  );
}

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={false}
      className={({ isActive }) =>
        cx(
          "rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-150",
          isActive ? "bg-surface-2 text-ink" : "text-muted hover:text-ink",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-toast) focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-(--z-sticky) border-b border-line bg-bg/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Wordmark />
          <nav aria-label="Main" className="ml-2 flex items-center gap-1">
            <NavItem to="/shows">Shows</NavItem>
            {session && (
              <NavItem to="/bookings">
                <span className="sm:hidden">Bookings</span>
                <span className="hidden sm:inline">My bookings</span>
              </NavItem>
            )}
            <NavItem to="/stampede">
              <span className="sm:hidden">Sim</span>
              <span className="hidden sm:inline">Stampede</span>
            </NavItem>
            <NavItem to="/war-room">
              <span className="sm:hidden">Ops</span>
              <span className="hidden sm:inline">War Room</span>
            </NavItem>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <Readiness />
            {session ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-sm whitespace-nowrap text-ink-2 sm:inline">
                  <span className="hidden text-muted lg:inline">Signed in as </span>
                  <span className="font-medium text-ink">{session.userId}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    signOut();
                    navigate("/shows");
                  }}
                >
                  Sign out
                </Button>
              </div>
            ) : location.pathname === "/login" ? null : (
              <Link
                to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
                className={buttonClass("secondary", "sm")}
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-16 sm:px-6">
        {children}
      </main>
    </div>
  );
}
