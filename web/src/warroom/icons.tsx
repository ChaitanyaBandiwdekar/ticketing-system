/** Status glyphs: state always ships as icon + label, never color alone. */
import { cx } from "../components/ui";

export const CheckIcon = ({ className = "size-5" }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={cx("shrink-0", className)} aria-hidden>
    <path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AlertIcon = ({ className = "size-5" }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={cx("shrink-0", className)} aria-hidden>
    <path d="M8 3v6M8 12v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

export const CrossIcon = ({ className = "size-5" }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={cx("shrink-0", className)} aria-hidden>
    <path
      d="M4.5 4.5l7 7M11.5 4.5l-7 7"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    />
  </svg>
);
