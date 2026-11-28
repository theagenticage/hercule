/**
 * Builds the label of the model options selector: a short summary of the
 * picked options, such as `High ⚡`. It uses each choice's label rather than
 * its value, because a label is display text and a value is a slug.
 *
 * The reasoning part comes from the `effort` option, or else from the
 * `thinking` option. `thinking` is either an on/off switch (shown as
 * "Thinking on") or a list of levels (shown as the picked level's label, such
 * as "Max").
 *
 * Returns `null` when there is no reasoning option to show (the model has
 * none, or thinking is off). The selector then shows its own name, because a
 * bolt on its own would mean nothing.
 *
 * `describeOptionsLabel` returns the same label with the name of the option it
 * shows, for a selector that writes "Effort: High".
 */
import type { ModelOption } from "@hercule/contract";
import { buildOptionsMenu, type ModelOptionRow } from "./options-menu";

const readChoiceLabel = (row: ModelOptionRow): string =>
  row.choices.find((choice) => choice.value === row.value)?.label ?? row.value;

/**
 * Returns the label of the `thinking` option's current pick, or `null` when
 * thinking is off. A switch shows "Thinking on"; a list of levels shows the
 * picked level's label. A list can offer an `off` level, which means the same
 * as the switch being off.
 */
const readThinkingLabel = (thinking: ModelOptionRow): string | null => {
  if (thinking.value === "off") return null;
  return thinking.boolean ? "Thinking on" : readChoiceLabel(thinking);
};

/** Returns the thinking option's part of the label, or `null` while thinking is off. */
const describeThinking = (thinking: ModelOptionRow): OptionsLabel | null => {
  const value = readThinkingLabel(thinking);
  if (value === null) return null;
  return { name: thinking.boolean ? null : "Thinking", value };
};

/**
 * The label of the model options selector in two parts: `name`, the option
 * the value belongs to ("Effort" or "Thinking"), and `value`, the label
 * `buildOptionsLabel` returns. `name` is `null` when the value already names
 * its option, as "Thinking on" does.
 */
export interface OptionsLabel {
  readonly name: "Effort" | "Thinking" | null;
  readonly value: string;
}

/**
 * Returns the label of the model options selector with the name of the option
 * it shows, so that "High" can read "Effort: High". Returns `null` exactly when
 * `buildOptionsLabel` does.
 */
export const describeOptionsLabel = (
  descriptors: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): OptionsLabel | null => {
  const rows = buildOptionsMenu(descriptors, selected);
  const findRow = (id: string): ModelOptionRow | undefined => rows.find((row) => row.id === id);
  const effort = findRow("effort");
  const thinking = findRow("thinking");

  const reasoning: OptionsLabel | null =
    effort !== undefined
      ? { name: "Effort", value: readChoiceLabel(effort) }
      : thinking !== undefined
        ? describeThinking(thinking)
        : null;
  if (reasoning === null) return null;

  return findRow("fastMode")?.value === "on"
    ? { name: reasoning.name, value: `${reasoning.value} ⚡` }
    : reasoning;
};

/** Returns the label of the model options selector, such as "High ⚡" (see the top of this file). */
export const buildOptionsLabel = (
  descriptors: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): string | null => describeOptionsLabel(descriptors, selected)?.value ?? null;
