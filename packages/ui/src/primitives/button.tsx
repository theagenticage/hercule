import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A quiet button stays borderless when it cannot be used: giving it a box there
 * would be the one shape on the surface that says "this commits", which is what
 * the `form` variant means. It recedes to the faintest ink instead, and the
 * cursor says the same thing on the way past. Why it cannot be used is written
 * beside it.
 */
const disabledShape = "disabled:cursor-not-allowed disabled:text-faint";

/**
 * Decision affordances are quiet: text only, a soft background on hover, and
 * the primary answer set apart by ink rather than by a fill. `form` is the one
 * exception, and it is not a monitoring surface: a form's submit carries a
 * hairline and a surface ground so it reads as the thing that commits.
 *
 * Hover is on the enabled state only, because a button that cannot be pressed
 * still receives the pointer: it has to answer for its own cursor.
 */
const variants = {
  quiet: `text-muted enabled:hover:bg-line-soft enabled:hover:text-ink ${disabledShape}`,
  primary: `text-ink enabled:hover:bg-line-soft ${disabledShape}`,
  form: `border border-line bg-surface px-3 py-1.5 text-body text-ink enabled:hover:bg-line-soft disabled:cursor-not-allowed disabled:opacity-60`,
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
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
