import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A button that cannot be used is either `disabled`, or `aria-disabled` when it
 * must keep the keyboard focus, as a Save whose write is in flight must. The
 * two look the same.
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
 * A form's submit keeps its box and fades its label when it cannot be used. It
 * fades the label only, and not the whole button, so the focus ring of an
 * `aria-disabled` Save keeps its full contrast.
 */
const disabledForm = [
  "disabled:cursor-not-allowed disabled:text-faint",
  "aria-disabled:cursor-not-allowed aria-disabled:text-faint",
].join(" ");

/** Hover is on a button that can be used only. */
const usableHover = "enabled:not-aria-disabled:hover:bg-line-soft";

/**
 * Decision affordances are quiet: text only, a soft background on hover, and
 * the primary answer set apart by ink rather than by a fill. `form` is the one
 * exception, and it is not a monitoring surface: a form's submit carries a
 * hairline and a surface ground so it reads as the thing that commits.
 *
 * Hover is on the usable state only, because a button that cannot be pressed
 * still receives the pointer: it has to answer for its own cursor.
 */
const variants = {
  quiet: `text-muted ${usableHover} enabled:not-aria-disabled:hover:text-ink ${disabledQuiet}`,
  primary: `text-ink ${usableHover} ${disabledPrimary}`,
  form: `border border-line bg-surface px-3 py-1.5 text-body text-ink ${usableHover} ${disabledForm}`,
};

export type ButtonVariant = keyof typeof variants;

/** The look every button-shaped thing wears - a caller that needs it on a Link reads it directly. */
export const buttonClassName = (variant: ButtonVariant, className: string | undefined): string =>
  cn(
    "inline-flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-row leading-none font-emph",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
    variants[variant],
    className,
  );

/** A button. While it is `aria-disabled`, it keeps the focus and ignores presses. */
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
      className={buttonClassName(variant, className)}
      onClick={(event) => {
        if (isInert) event.preventDefault();
        else onClick?.(event);
      }}
      {...props}
    />
  );
}
