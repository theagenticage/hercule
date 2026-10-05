import type { JSX, ReactNode } from "react";
import { cn } from "./cn";

/**
 * Renders the button that opens and closes a fold below it: a quiet row of
 * fine, muted text with a chevron at its end, which turns down while the
 * fold is open. The row fills on hover and while open. `useTabFlag` holds
 * whether the fold is open, so it stays open across page loads in the tab.
 *
 * `className` sets the button's width and margins, which differ by where the
 * fold sits.
 */
export function DisclosureButton({
  open,
  onToggle,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
  /** What the row shows before the chevron. */
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-control px-2.5 py-1 text-left text-fine text-muted",
        "hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn("text-fine text-faint transition-transform", open && "rotate-90")}
      >
        ›
      </span>
    </button>
  );
}
