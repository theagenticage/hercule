import type { JSX } from "react";
import { FlagIcon } from "../../icons/flag";

/**
 * Renders a small flag in the colour of `hue`, such as an Initiative's, at
 * the lightness and chroma of the current theme (`--plan-l`, `--plan-c`). The
 * colour is set on the element itself, so no ancestor needs to declare it.
 */
export function HueFlag({ hue }: { readonly hue: number }): JSX.Element {
  return (
    <span
      className="hue-flag"
      style={{ color: `oklch(var(--plan-l) var(--plan-c) ${String(hue)})` }}
    >
      <FlagIcon size={14} />
    </span>
  );
}
