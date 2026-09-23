/**
 * Builds the label of the model options selector: a short summary of the
 * picked options, such as `high ⚡`. It uses each choice's label rather than
 * its value, because a label is display text and a value is a slug.
 *
 * Returns `null` when there is no reasoning option to show (the model has
 * none, or thinking is off). The selector then shows its own name, because a
 * bolt on its own would mean nothing.
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
