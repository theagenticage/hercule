/**
 * What the model options selector draws: one row per descriptor the model
 * declares, with the choices as the provider wrote them. A boolean descriptor
 * has no choices of its own, so it reads as the two-way switch it is - and the
 * row says so, because a pick under it goes back as a boolean, not as "on".
 */
import type { ModelOption } from "@hydra/contract";

/** A boolean descriptor is a two-way switch, and reads as one. */
const SWITCH = [
  { value: "off", label: "off" },
  { value: "on", label: "on" },
];

export interface ModelOptionRow {
  readonly id: string;
  readonly label: string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  /** What is picked under it now: the value stored, else the declared default. */
  readonly value: string;
  readonly boolean: boolean;
}

export const optionsMenu = (
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
