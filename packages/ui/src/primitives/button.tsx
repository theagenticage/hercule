import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * A button that cannot be used is either `disabled` or `aria-disabled`. Use
 * `aria-disabled` when the button must keep keyboard focus, such as a Save
 * button while its save is in flight. Both look the same.
 *
 * A quiet button stays borderless when it cannot be used. Only the `form`
 * variant has a box, because a box marks the button that commits a form.
 */
const disabledQuiet = [
  "disabled:cursor-not-allowed disabled:text-faint",
  "aria-disabled:cursor-not-allowed aria-disabled:text-faint",
].join(" ");

/**
 * A primary button gains an outlined box when it cannot be used. It is often
 * the only control on the surface, and without a box its muted label would
 * look like plain text. The outline is an inset shadow, not a border, so a
 * primary button stays the same height as a quiet one beside it.
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
 * Buttons are quiet: text only, with a soft background on hover. The primary
 * button stands out by its ink colour, not by a fill. `form` is the exception:
 * a form's submit button has a thin border and a surface background, so it
 * reads as the button that commits the form.
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

/**
 * Builds the class names for a button of the given variant, with the caller's
 * `className` applied last. Use it directly to style a Link as a button.
 *
 * A button's label never wraps: a label broken over two lines, such as "Re-"
 * above "run", no longer reads as one button. A row too narrow for its
 * buttons must give way somewhere else.
 */
export const buildButtonClassName = (
  variant: ButtonVariant,
  className: string | undefined,
): string =>
  cn(
    "inline-flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-row leading-none font-emph whitespace-nowrap",
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
