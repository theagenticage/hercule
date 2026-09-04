import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * Decision affordances are quiet: text only, a soft background on hover, and
 * the primary answer set apart by ink rather than by a fill.
 */
const variants = {
  quiet: "text-muted hover:bg-line-soft hover:text-ink",
  primary: "text-ink hover:bg-line-soft",
};

export type ButtonVariant = keyof typeof variants;

export function Button({
  variant = "quiet",
  type = "button",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }): JSX.Element {
  return (
    <button
      type={type}
      data-variant={variant}
      className={cn(
        "inline-flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-row leading-none font-emph",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
