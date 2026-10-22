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

export const buildOptionsLabel = (
  descriptors: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): string | null => {
  const rows = buildOptionsMenu(descriptors, selected);
  const findRow = (id: string): ModelOptionRow | undefined => rows.find((row) => row.id === id);
  const effort = findRow("effort");
  const thinking = findRow("thinking");

  const reasoning =
    effort !== undefined
      ? readChoiceLabel(effort)
      : thinking !== undefined
        ? readThinkingLabel(thinking)
        : null;
  if (reasoning === null) return null;

  return findRow("fastMode")?.value === "on" ? `${reasoning} ⚡` : reasoning;
};
