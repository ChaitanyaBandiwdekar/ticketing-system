/**
 * The component vocabulary. One button shape, one field shape, one pill shape, used everywhere;
 * every interactive piece has hover, focus-visible, active, disabled and (where it applies)
 * loading states.
 */
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none " +
  "transition-[background-color,border-color,color,transform] duration-150 ease-(--ease-out-quart) " +
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-45";

const BUTTON_VARIANT = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary:
    "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3 hover:border-muted",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "border border-danger/50 text-danger hover:bg-danger-soft",
} as const;

const BUTTON_SIZE = { sm: "h-8 px-3 text-[0.8125rem]", md: "h-10 px-4 text-sm" } as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

/** Same look as Button, for router links styled as actions. */
export function buttonClass(
  variant: ButtonProps["variant"] = "secondary",
  size: ButtonProps["size"] = "md",
): string {
  return cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size]);
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent",
        className,
      )}
    />
  );
}

type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
};

/** Label + control + hint/error, wired for screen readers. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const describedBy = error || hint ? hintId : undefined;
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-ink-2">
        {label}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {error ? (
        <p id={hintId} className="text-[0.8125rem] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[0.8125rem] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; suffix?: ReactNode }
>(function Input({ className, invalid, suffix, ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        "h-10 w-full rounded-md border bg-surface px-3 text-sm text-ink placeholder:text-muted",
        "transition-colors duration-150 hover:border-line-strong",
        "focus-visible:border-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-soft",
        "disabled:opacity-50",
        invalid ? "border-danger" : "border-line",
        suffix ? "pr-12" : null,
        className,
      )}
      {...rest}
    />
  );
  if (!suffix) return input;
  return (
    <div className="relative">
      {input}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[0.8125rem] text-muted">
        {suffix}
      </span>
    </div>
  );
});

type SegmentedProps<T extends string> = {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
};

/** A radio group drawn as a segmented control (arrow keys move, as native radios do). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[0.8125rem] font-medium text-ink-2">{label}</legend>
      <div className="inline-flex w-fit rounded-md border border-line bg-surface p-0.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              "relative cursor-pointer rounded-[0.3rem] px-3 py-1.5 text-[0.8125rem] font-medium transition-colors duration-150",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-primary-ink",
              value === o.value ? "bg-surface-3 text-ink" : "text-muted hover:text-ink",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="relative mt-0.5 inline-flex">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer h-5 w-9 cursor-pointer appearance-none rounded-full border border-line-strong bg-surface-2 transition-colors duration-150 checked:border-primary checked:bg-primary"
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-ink-2 transition-transform duration-150 ease-(--ease-out-quart) peer-checked:translate-x-4 peer-checked:bg-white"
        />
      </span>
      <span className="flex flex-col">
        <label htmlFor={id} className="cursor-pointer text-sm text-ink">
          {label}
        </label>
        {hint && (
          <span id={`${id}-hint`} className="text-[0.8125rem] text-muted">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}

type Tone = "neutral" | "success" | "danger" | "amber" | "primary";
const PILL_TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  amber: "bg-amber-soft text-amber",
  primary: "bg-primary-soft text-primary-ink",
};

export function Pill({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx("block animate-pulse rounded-md bg-surface-2", className)} />
  );
}

export function Notice({
  tone = "danger",
  title,
  children,
  action,
}: {
  tone?: "danger" | "amber" | "neutral";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const toneClass = {
    danger: "border-danger/40 bg-danger-soft",
    amber: "border-amber/40 bg-amber-soft",
    neutral: "border-line bg-surface",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4",
        toneClass,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium text-ink">{title}</p>
        {children && <div className="text-[0.8125rem] text-ink-2">{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** The request id behind an error, so a reader can find it in the logs. */
export function RequestId({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return (
    <span className="font-mono text-xs text-muted">
      request <span className="select-all text-ink-2">{id}</span>
    </span>
  );
}
