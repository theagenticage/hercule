/**
 * How long ago a thread was last active, as a thread's tab in the header and
 * its row in the sidebar show it.
 */
import type { JSX } from "react";
import { useAgeLabel, useAgeWords } from "../app/age-clock";

/**
 * Renders how long ago `at` was: "20m" on screen, and "20 minutes ago" in a
 * hidden element with the id `descriptionId`, which the description of the
 * tab or row holding the age points at.
 *
 * - `as` is the element that holds "20m": the header's tabs size a `<small>`,
 *   and the sidebar's rows size the element around a `<span>`.
 * - `className` is set on that element.
 * - `onScreen` says whether the age is in the visible part of its list. The
 *   age is kept current only then.
 */
export function AgeLabel({
  at,
  onScreen,
  descriptionId,
  as: Label,
  className,
}: {
  readonly at: string;
  readonly onScreen: boolean;
  readonly descriptionId: string;
  readonly as: "small" | "span";
  readonly className?: string;
}): JSX.Element {
  const label = useAgeLabel(at, onScreen);
  const words = useAgeWords(at, onScreen);
  return (
    <>
      <Label className={className}>{label}</Label>
      <span id={descriptionId} hidden>
        {words}
      </span>
    </>
  );
}
