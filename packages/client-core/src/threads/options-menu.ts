/**
 * Builds the rows of the model options selector: one row per option the model
 * declares, with the choices as the provider defined them. A boolean option
 * has no choices of its own, so it is shown as an off/on switch. Its row is
 * marked `boolean`, because a pick is sent back as a boolean, not as "on".
 */
import type { ModelOption } from "@hercule/contract";

/** The two choices of a boolean option. */
const SWITCH = [
  { value: "off", label: "off" },
  { value: "on", label: "on" },
];

export interface ModelOptionRow {
  readonly id: string;
  readonly label: string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  /** The current pick: the stored value, or else the declared default. */
  readonly value: string;
  readonly boolean: boolean;
}

export const buildOptionsMenu = (
  descriptors: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): readonly ModelOptionRow[] =>
  descriptors.map((option) => {
    const value = selected[option.id] ?? option.default;
    const isBoolean = option.kind === "boolean";
    return {
      id: option.id,
      label: option.label,
      choices: isBoolean ? SWITCH : (option.choices ?? []),
      value: isBoolean ? (value === true ? "on" : "off") : String(value),
      boolean: isBoolean,
    };
  });
