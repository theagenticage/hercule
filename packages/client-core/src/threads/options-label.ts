/**
 * The model options selector's own label: what is picked under the model, in
 * one word. Reads the choice's label rather than its value, because a label is
 * copy and a value is a slug. It says nothing at all where there is no word
 * to say - no reasoning choice, or one that is off - and the selector then
 * carries its own name: a bolt on its own would name nothing.
 */
import type { ModelOption } from "@hercule/contract";
import { buildOptionsMenu, type ModelOptionRow } from "./options-menu";

const readChoiceLabel = (row: ModelOptionRow): string =>
  (row.choices.find((choice) => choice.value === row.value)?.label ?? row.value).toLowerCase();

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
      : thinking !== undefined && thinking.value === "on"
        ? "thinking on"
        : null;
  if (reasoning === null) return null;

  return findRow("fastMode")?.value === "on" ? `${reasoning} ⚡` : reasoning;
};
