import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";
import { AppShell } from "../components/AppShell";
import { buttonClass } from "../components/ui";
import { ApiError } from "../lib/api";
import { SessionProvider } from "../lib/session";
import { BookingsPage } from "../pages/BookingsPage";
import { LoginPage } from "../pages/LoginPage";
import { NewShowPage } from "../pages/NewShowPage";
import { ShowPage } from "../pages/ShowPage";
import { ShowsPage } from "../pages/ShowsPage";
import { StampedePage } from "../pages/StampedePage";

// The War Room carries the charting library; only its visitors download it.
const WarRoomPage = lazy(() =>
  import("../pages/WarRoomPage").then((m) => ({ default: m.WarRoomPage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      refetchOnWindowFocus: true,
      // A 4xx is an answer, not a blip: don't retry it.
      retry: (failures, err) =>
        failures < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
});

function NotFound() {
  return (
    <div className="flex max-w-md flex-col gap-3 pt-10">
      <h1 className="text-2xl font-semibold">This page isn't showing</h1>
      <p className="text-ink-2">There's nothing at this address.</p>
      <Link to="/shows" className={buttonClass("secondary", "sm") + " w-fit"}>
        Back to shows
      </Link>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter basename="/app">
          <AppShell>
            <Routes>
              <Route index element={<Navigate to="/shows" replace />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="shows" element={<ShowsPage />} />
              <Route path="shows/new" element={<NewShowPage />} />
              <Route path="shows/:id" element={<ShowPage />} />
              <Route path="bookings" element={<BookingsPage />} />
              <Route
                path="war-room"
                element={
                  <Suspense fallback={<p className="pt-10 text-muted">Opening the War Room…</p>}>
                    <WarRoomPage />
                  </Suspense>
                }
              />
              <Route path="stampede" element={<StampedePage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppShell>
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
}
