import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A quiet button stays borderless when it cannot be used: a box is the one shape
 * that says "this commits", which is what the `form` variant means.
 */
const disabledQuiet = "disabled:cursor-not-allowed disabled:text-faint";

/**
 * The primary answer keeps its box when it cannot be used, because it is often
 * the only affordance on the surface and boxless it reads as prose. The
 * hairline is inset rather than a border, so a primary beside a quiet one is
 * the same height in either state.
 */
const disabledPrimary = [
  "disabled:cursor-not-allowed",
  "disabled:bg-surface disabled:text-muted",
  "disabled:shadow-[inset_0_0_0_1px_var(--color-line)]",
].join(" ");

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
  quiet: `text-muted enabled:hover:bg-line-soft enabled:hover:text-ink ${disabledQuiet}`,
  primary: `text-ink enabled:hover:bg-line-soft ${disabledPrimary}`,
  form: `border border-line bg-surface px-3 py-1.5 text-body text-ink enabled:hover:bg-line-soft disabled:cursor-not-allowed disabled:opacity-60`,
};

export type ButtonVariant = keyof typeof variants;

/** The look every button-shaped thing wears, `Button` and `ButtonLink` alike. */
const buttonClassName = (variant: ButtonVariant, className: string | undefined): string =>
  cn(
    "inline-flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-row leading-none font-emph",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
    variants[variant],
    className,
  );

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
      className={buttonClassName(variant, className)}
      {...props}
    />
  );
}

/**
 * A button-shaped navigation: an affordance that goes somewhere rather than
 * commits something. `disabled:`/`enabled:` in a variant's classes are simply
 * inert here - a link is never disabled, it is offered or it is not offered.
 */
export function ButtonLink({
  variant = "quiet",
  className,
  ...props
}: ComponentProps<"a"> & { variant?: ButtonVariant }): JSX.Element {
  return <a data-variant={variant} className={buttonClassName(variant, className)} {...props} />;
}
