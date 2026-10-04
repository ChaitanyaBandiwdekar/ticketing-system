import { useMemo, useState, type SubmitEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  Button,
  Field,
  Input,
  Notice,
  RequestId,
  Segmented,
  Switch,
  buttonClass,
} from "../components/ui";
import { HallCanvas, HallLegend, Screen } from "../hall/HallCanvas";
import {
  LIMITS,
  defaultAisles,
  generateSeats,
  normalizeSpec,
  parseNumberList,
  rowLabel,
  toLayout,
} from "../hall/generator";
import { hallGeometry } from "../hall/geometry";
import { ApiError, describeError } from "../lib/api";
import { num, rupees } from "../lib/format";
import { useCreateShow } from "../lib/queries";
import { useSession } from "../lib/session";

type Mode = "instant" | "hold";

type Errors = Partial<
  Record<"name" | "rows" | "seats" | "price" | "limit" | "ttl" | "key", string>
>;

function intIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** "250" / "250.5" / "1,250.75" rupees -> integer paise, or null. */
function toPaise(text: string): number | null {
  const t = text.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const paise = Math.round(Number(t) * 100);
  return paise >= 1 && paise <= 10_000_000 ? paise : null;
}

export function NewShowPage() {
  const navigate = useNavigate();
  const { adminKey, setAdminKey } = useSession();
  const create = useCreateShow(adminKey);

  const [name, setName] = useState("");
  const [rows, setRows] = useState("12");
  const [seatsPerRow, setSeatsPerRow] = useState("20");
  const [aisles, setAisles] = useState(defaultAisles(20).join(", "));
  const [aislesTouched, setAislesTouched] = useState(false);
  const [gaps, setGaps] = useState("");
  const [price, setPrice] = useState("250");
  const [limit, setLimit] = useState("4");
  const [mode, setMode] = useState<Mode>("instant");
  const [ttl, setTtl] = useState("120");
  const [ephemeral, setEphemeral] = useState(false);
  const [key, setKey] = useState(adminKey ?? "");
  const [errors, setErrors] = useState<Errors>({});

  const rowsN = intIn(rows, 1, LIMITS.maxRows);
  const seatsN = intIn(seatsPerRow, 1, LIMITS.maxSeatsPerRow);
  const spec = useMemo(
    () =>
      normalizeSpec({
        rows: rowsN ?? 1,
        seatsPerRow: seatsN ?? 1,
        aislesAfter: parseNumberList(aisles),
        rowGapsAfter: parseNumberList(gaps),
      }),
    [rowsN, seatsN, aisles, gaps],
  );
  const seats = useMemo(() => generateSeats(spec), [spec]);
  const layout = useMemo(() => toLayout(spec), [spec]);
  const geometry = useMemo(() => hallGeometry(seats, layout), [seats, layout]);
  const paint = useMemo(() => ({ status: "a".repeat(seats.length) }), [seats.length]);
  const pricePaise = toPaise(price);

  function onSeatsPerRow(value: string) {
    setSeatsPerRow(value);
    const n = intIn(value, 1, LIMITS.maxSeatsPerRow);
    // Keep the suggested aisles in step until the user edits them.
    if (n && !aislesTouched) setAisles(defaultAisles(n).join(", "));
  }

  function validate(): Errors {
    const e: Errors = {};
    if (!name.trim()) e.name = "Give the show a name.";
    if (rowsN === null) e.rows = `1–${LIMITS.maxRows} rows.`;
    if (seatsN === null) e.seats = `1–${LIMITS.maxSeatsPerRow} seats per row.`;
    if (pricePaise === null) e.price = "A price in rupees, e.g. 250 or 199.50 (up to ₹1,00,000).";
    if (intIn(limit, 1, 100) === null) e.limit = "1–100 seats per person.";
    if (mode === "hold" && intIn(ttl, 1, 3600) === null) e.ttl = "1–3600 seconds.";
    if (!key.trim()) e.key = "The admin key is required to create shows.";
    return e;
  }

  async function submit(ev: SubmitEvent<HTMLFormElement>) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setAdminKey(key.trim());
    try {
      const show = await create.mutateAsync({
        name: name.trim(),
        seats,
        price_paise: pricePaise!,
        per_user_limit: Number(limit),
        hold_ttl_seconds: mode === "hold" ? Number(ttl) : null,
        ephemeral,
        layout,
      });
      navigate(`/shows/${show.id}`);
    } catch (err) {
      if (err instanceof ApiError && (err.code === "forbidden" || err.code === "unauthorized")) {
        setErrors({ key: "That admin key isn't valid." });
        setAdminKey(null);
      }
    }
  }

  const apiError = create.error instanceof ApiError ? create.error : null;
  const keyError = apiError && (apiError.code === "forbidden" || apiError.code === "unauthorized");
  const gapRows = spec.rowGapsAfter.map((r) => rowLabel(r - 1));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <Link to="/shows" className="w-fit text-[0.8125rem] text-muted hover:text-ink">
          ← Shows
        </Link>
        <h1 className="text-2xl font-semibold">New show</h1>
        <p className="max-w-2xl text-ink-2">
          Lay out the hall, set the price and how reserving works. Seats are labelled by row letter
          and number (A1, A2…), which is what the API and burst scripts use.
        </p>
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <form onSubmit={submit} noValidate className="flex flex-col gap-8">
          <fieldset className="flex flex-col gap-5">
            <legend className="mb-4 text-base font-medium">Show</legend>
            <Field label="Name" error={errors.name}>
              {(p) => (
                <Input
                  id={p.id}
                  aria-describedby={p.describedBy}
                  invalid={p.invalid}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Pushpa 3 · First day, first show · 6 AM"
                  maxLength={200}
                />
              )}
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-4 text-base font-medium">Hall</legend>
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Rows"
                error={errors.rows}
                hint={rowsN ? `A–${rowLabel(rowsN - 1)}` : undefined}
              >
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    invalid={p.invalid}
                    inputMode="numeric"
                    value={rows}
                    onChange={(e) => setRows(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Seats per row" error={errors.seats}>
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    invalid={p.invalid}
                    inputMode="numeric"
                    value={seatsPerRow}
                    onChange={(e) => onSeatsPerRow(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Aisles after seat"
              hint="Seat numbers, comma-separated. Leave empty for none."
            >
              {(p) => (
                <Input
                  id={p.id}
                  aria-describedby={p.describedBy}
                  inputMode="numeric"
                  value={aisles}
                  onChange={(e) => {
                    setAisles(e.target.value);
                    setAislesTouched(true);
                  }}
                  placeholder="e.g. 5, 15"
                />
              )}
            </Field>
            <Field
              label="Cross-aisle after row"
              hint={
                gapRows.length
                  ? `After row ${gapRows.join(", ")}.`
                  : "Row numbers, e.g. 6 puts a walkway after row F."
              }
            >
              {(p) => (
                <Input
                  id={p.id}
                  aria-describedby={p.describedBy}
                  inputMode="numeric"
                  value={gaps}
                  onChange={(e) => setGaps(e.target.value)}
                  placeholder="optional"
                />
              )}
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-4 text-base font-medium">Selling</legend>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Ticket price (₹)" error={errors.price}>
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    invalid={p.invalid}
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Limit per person" error={errors.limit}>
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    invalid={p.invalid}
                    inputMode="numeric"
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                    suffix="seats"
                  />
                )}
              </Field>
            </div>
            <Segmented<Mode>
              label="When someone reserves"
              value={mode}
              onChange={setMode}
              options={[
                { value: "instant", label: "Confirm instantly" },
                { value: "hold", label: "Hold, then confirm" },
              ]}
            />
            {mode === "hold" && (
              <Field
                label="Hold time"
                error={errors.ttl}
                hint="Unconfirmed holds expire and their seats go back on sale."
              >
                {(p) => (
                  <Input
                    id={p.id}
                    aria-describedby={p.describedBy}
                    invalid={p.invalid}
                    inputMode="numeric"
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    suffix="sec"
                  />
                )}
              </Field>
            )}
            <Switch
              checked={ephemeral}
              onChange={setEphemeral}
              label="Burst show"
              hint="Hidden from the default list and deleted after 24 hours."
            />
          </fieldset>

          <fieldset className="flex flex-col gap-5">
            <legend className="mb-4 text-base font-medium">Authorisation</legend>
            <Field
              label="Admin key"
              error={errors.key ?? (keyError ? "That admin key isn't valid." : null)}
              hint="Sent as a bearer token. Kept in this tab only."
            >
              {(p) => (
                <Input
                  id={p.id}
                  aria-describedby={p.describedBy}
                  invalid={p.invalid}
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              )}
            </Field>
          </fieldset>

          {create.isError && !keyError && (
            <Notice title="The show wasn't created">
              {describeError(create.error)}
              {apiError?.details.issues ? (
                <ul className="mt-1 list-disc pl-4">
                  {(apiError.details.issues as string[]).map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}{" "}
              <RequestId id={apiError?.requestId} />
            </Notice>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create show
            </Button>
            <Link to="/shows" className={buttonClass("ghost")}>
              Cancel
            </Link>
          </div>
        </form>

        <section
          aria-label="Hall preview"
          className="flex h-fit flex-col gap-5 rounded-lg border border-line bg-surface/40 p-5 lg:sticky lg:top-20"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-medium">Preview</h2>
            <p className="tabular text-[0.8125rem] text-muted">
              <span className="text-ink">{num(seats.length)}</span> seats · {spec.rows} ×{" "}
              {spec.seatsPerRow}
              {pricePaise !== null && (
                <>
                  {" "}
                  · full house <span className="text-ink">{rupees(pricePaise * seats.length)}</span>
                </>
              )}
            </p>
          </div>
          <div>
            <Screen />
            <HallCanvas
              geometry={geometry}
              paint={paint}
              maxPitch={26}
              label={`Hall preview: ${seats.length} seats in ${spec.rows} rows`}
            />
          </div>
          <HallLegend />
        </section>
      </div>
    </div>
  );
}
