import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A quiet button is borderless at rest, which leaves a disabled one reading as
 * plain text. The ring gives it back its shape without moving anything: a
 * control the user cannot use is still a control, and the reason it cannot be
 * used is written beside it.
 */
const disabledShape = "disabled:bg-surface disabled:ring-1 disabled:ring-faint/45";

/**
 * Decision affordances are quiet: text only, a soft background on hover, and
 * the primary answer set apart by ink rather than by a fill. `form` is the one
 * exception, and it is not a monitoring surface: a form's submit carries a
 * hairline and a surface ground so it reads as the thing that commits.
 */
const variants = {
  quiet: `text-muted hover:bg-line-soft hover:text-ink ${disabledShape}`,
  primary: `text-ink hover:bg-line-soft ${disabledShape}`,
  form: "border border-line bg-surface px-3 py-1.5 text-body text-ink hover:bg-line-soft",
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
        "disabled:pointer-events-none disabled:opacity-70",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
