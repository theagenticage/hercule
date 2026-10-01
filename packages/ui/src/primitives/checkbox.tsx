import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * Renders a checkbox with its label beside it, inside one clickable element.
 * A label stacked above a lone box leaves the reader guessing what the tick
 * belongs to, and the whole row is a bigger click target.
 */
export function Checkbox({
  label,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className"> & {
  readonly label: string;
}): JSX.Element {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <ChoiceInput type="checkbox" {...props} />
      <span className="text-meta font-emph text-muted">{label}</span>
    </label>
  );
}

/**
 * Renders the box of a checkbox or the circle of a radio, without a label,
 * for a caller that lays out its own label. The browser's own control is
 * hidden so the choice can use `Input`'s border and focus style; the tick of
 * a checkbox and the dot of a radio are drawn here instead. `className`
 * goes on the box's wrapper, so the caller can place the box; every other
 * prop goes on the `<input>`.
 *
 * A checked choice is filled with ink, like a switch that is on. It uses no
 * colour, because the design language uses colour only at the size of a word
 * or a dot, and the live colour means that something is running.
 */
export function ChoiceInput({
  type,
  className,
  ...props
}: ComponentProps<"input"> & { readonly type: "checkbox" | "radio" }): JSX.Element {
  return (
    <span
      className={cn(
        "relative inline-flex size-3.5 shrink-0 items-center justify-center",
        className,
      )}
    >
      <input
        type={type}
        className={cn(
          "peer size-3.5 cursor-pointer appearance-none border border-line bg-raised checked:border-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // A radio's dot is a ring of the background inside an ink fill, so
          // it needs no second element.
          type === "checkbox"
            ? "rounded-[4px] checked:bg-ink"
            : "rounded-full checked:shadow-[inset_0_0_0_3px_var(--color-raised),inset_0_0_0_7px_var(--color-ink)]",
        )}
        {...props}
      />
      {type === "radio" ? null : (
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
      )}
    </span>
  );
}
