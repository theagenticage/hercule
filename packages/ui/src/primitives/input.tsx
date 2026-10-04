import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/** Renders a one-line text field in the app's style. Every `<input>` prop is passed through. */
export function Input({ className, ...props }: ComponentProps<"input">): JSX.Element {
  return (
    <input
      className={cn(
        "w-full rounded-control border border-line bg-raised px-2.5 py-1.5 text-body text-ink",
        "placeholder:text-faint",
        "focus-visible:border-live focus-visible:outline-none",
        "disabled:opacity-50",
        // A number field shows no stepper arrows. The browser draws them in its
        // own style, which matches neither theme, and nobody steps an interval
        // or a count one unit at a time.
        "[&[type=number]]:[appearance:textfield]",
        "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        className,
      )}
      {...props}
    />
  );
}
