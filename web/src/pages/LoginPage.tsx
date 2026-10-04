import { useState, type SubmitEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Field, Input } from "../components/ui";
import { ApiError, describeError } from "../lib/api";
import { useSession } from "../lib/session";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Only same-app paths, so ?next= can't bounce a user off-site. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/shows";
}

export function LoginPage() {
  const { session, signIn } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={next} replace />;

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = username.trim();
    if (!USERNAME.test(name)) {
      setError(
        "Use 1–64 letters, numbers, dots, dashes or underscores, starting with a letter or number.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(name);
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "not_found"
          ? "Demo sign-in is turned off on this server."
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-8 pt-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Take your seat</h1>
        <p className="text-ink-2">
          Sign in with any username. This demo identity provider issues a 24-hour token, and the
          name you type becomes your user id: it decides whose seats are whose and counts toward the
          per-user limit.
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field
          label="Username"
          error={error}
          hint="Two browsers with two names can race for the same seat."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="e.g. priya"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={64}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!username.trim()}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
