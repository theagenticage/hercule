import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A boolean, as a box with its name beside it.
 *
 * The name is part of the control rather than a label stacked above it: a lone
 * box under a heading leaves the reader working out which of the two the tick
 * belongs to, and the whole row is a bigger thing to hit. It wears `Input`'s
 * border, ground and focus treatment so a form reads as one set of controls,
 * which means the platform's own box is off and the tick is drawn here.
 */
export function Checkbox({
  label,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { readonly label: string }): JSX.Element {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          className={cn(
            "peer size-3.5 cursor-pointer appearance-none rounded-[4px] border border-line bg-raised",
            "checked:border-live checked:bg-live",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          fill="none"
          className="pointer-events-none absolute size-2.5 text-raised opacity-0 peer-checked:opacity-100"
        >
          <path
            d="m2.6 6.2 2.2 2.2 4.6-4.8"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-meta font-emph text-muted">{label}</span>
    </label>
  );
}
