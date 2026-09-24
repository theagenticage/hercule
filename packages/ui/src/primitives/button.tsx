import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A button that cannot be used is either `disabled` or `aria-disabled`. Use
 * `aria-disabled` when the button must keep keyboard focus, such as a Save
 * button while its save is in flight. Both look the same.
 *
 * A quiet button stays borderless when it cannot be used: a box is the one shape
 * that says "this commits", which is what the `form` variant means.
 */
const disabledQuiet = [
  "disabled:cursor-not-allowed disabled:text-faint",
  "aria-disabled:cursor-not-allowed aria-disabled:text-faint",
].join(" ");

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
  "aria-disabled:cursor-not-allowed",
  "aria-disabled:bg-surface aria-disabled:text-muted",
  "aria-disabled:shadow-[inset_0_0_0_1px_var(--color-line)]",
].join(" ");

/**
 * A form button that cannot be used keeps its border and fades only its label.
 * Fading the whole button would also fade the focus ring of an
 * `aria-disabled` Save button.
 */
const disabledForm = [
  "disabled:cursor-not-allowed disabled:text-faint",
  "aria-disabled:cursor-not-allowed aria-disabled:text-faint",
].join(" ");

/** Hover styles apply only to a button that is neither `disabled` nor `aria-disabled`. */
const usableHover = "enabled:not-aria-disabled:hover:bg-line-soft";

/**
 * Decision affordances are quiet: text only, a soft background on hover, and
 * the primary answer set apart by ink rather than by a fill. `form` is the one
 * exception, and it is not a monitoring surface: a form's submit carries a
 * hairline and a surface ground so it reads as the thing that commits.
 *
 * Hover styles apply only to a usable button. A button that cannot be pressed
 * still receives pointer events, so it must show its own not-allowed cursor.
 */
const variants = {
  quiet: `text-muted ${usableHover} enabled:not-aria-disabled:hover:text-ink ${disabledQuiet}`,
  primary: `text-ink ${usableHover} ${disabledPrimary}`,
  form: `border border-line bg-surface px-3 py-1.5 text-body text-ink ${usableHover} ${disabledForm}`,
};

export type ButtonVariant = keyof typeof variants;

/** The look every button-shaped thing wears - a caller that needs it on a Link reads it directly. */
export const buildButtonClassName = (
  variant: ButtonVariant,
  className: string | undefined,
): string =>
  cn(
    "inline-flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-row leading-none font-emph",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
    variants[variant],
    className,
  );

/** While `aria-disabled`, the button keeps focus but ignores clicks and does not submit its form. */
export function Button({
  variant = "quiet",
  type = "button",
  className,
  onClick,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }): JSX.Element {
  const isInert = props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return (
    <button
      type={type}
      data-variant={variant}
      className={buildButtonClassName(variant, className)}
      onClick={(event) => {
        if (isInert) event.preventDefault();
        else onClick?.(event);
      }}
      {...props}
    />
  );
}
