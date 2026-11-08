import type { CSSProperties, JSX } from "react";
import { FlagIcon } from "../../icons/flag";
import "./initiatives.css";

/**
 * Returns the style that gives an element the colour of an Initiative: it sets
 * `--plan-hue`, from which `initiatives.css` derives `--plan-ink` and
 * `--plan-soft`.
 */
export const buildInitiativeHueStyle = (hue: number): CSSProperties => ({
  "--plan-hue": String(hue),
});

/**
 * Renders the 14px flag of an Initiative, in its colour. It stands in the head
 * of a row, for the lane of Group by Initiative, and in the head of a folded
 * Project lane for each Initiative the lane holds. `name`, when given, is the
 * flag's hover text and its name for a screen reader; without it the flag is
 * only decoration beside the name.
 */
export function InitiativeFlag({
  hue,
  name,
}: {
  readonly hue: number;
  readonly name?: string;
}): JSX.Element {
  return (
    <span
      className="initiative-flag"
      style={buildInitiativeHueStyle(hue)}
      {...(name === undefined
        ? {}
        : { role: "img", "aria-label": `Initiative ${name}`, title: name })}
    >
      <FlagIcon size={14} />
    </span>
  );
}
