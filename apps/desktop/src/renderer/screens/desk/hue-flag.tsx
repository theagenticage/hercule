import type { CSSProperties, JSX } from "react";
import { FlagIcon } from "../../icons/flag";

/**
 * Returns the style that gives an element a hue: it sets `--plan-hue`, from
 * which `styles/tokens.css` derives `--plan-ink` and `--plan-soft` on the
 * elements that use them. Used on the flag and on a row that draws in the
 * colour of its Initiative.
 */
export const buildHueStyle = (hue: number): CSSProperties => ({ "--plan-hue": String(hue) });

/**
 * Renders a small flag in the colour of `hue`, such as an Initiative's, at
 * the lightness and chroma of the current theme. It sets its own hue, so no
 * ancestor needs to declare it.
 *
 * - `size` is the icon's size in pixels. It is 14 when left out.
 * - `title` is the hover text.
 * - `label` is the flag's name for a screen reader, and its hover text when
 *   there is no `title`. A flag with a `label` is a picture that says
 *   something; without one it is decoration beside the words that say it.
 */
export function HueFlag({
  hue,
  size,
  title,
  label,
}: {
  readonly hue: number;
  readonly size?: number;
  readonly title?: string;
  readonly label?: string;
}): JSX.Element {
  return (
    <span
      className="hue-flag"
      style={buildHueStyle(hue)}
      {...(label === undefined ? {} : { role: "img", "aria-label": label })}
      {...(title === undefined && label === undefined ? {} : { title: title ?? label })}
    >
      <FlagIcon size={size ?? 14} />
    </span>
  );
}
