/**
 * The model options selector's own label: what is picked under the model, in
 * one word. Reads the choice's label rather than its value, because a label is
 * copy and a value is a slug. It says nothing at all where there is no word
 * to say - no reasoning choice, or one that is off - and the selector then
 * carries its own name: a bolt on its own would name nothing.
 */
import type { ModelOption } from "@hydra/contract";
import { optionsMenu, type ModelOptionRow } from "./options-menu";

const labelOf = (row: ModelOptionRow): string =>
  (row.choices.find((choice) => choice.value === row.value)?.label ?? row.value).toLowerCase();

export const optionsLabel = (
  descriptors: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): string | null => {
  const rows = optionsMenu(descriptors, selected);
  const rowOf = (id: string): ModelOptionRow | undefined => rows.find((row) => row.id === id);
  const effort = rowOf("effort");
  const thinking = rowOf("thinking");

  const reasoning =
    effort !== undefined
      ? labelOf(effort)
      : thinking !== undefined && thinking.value === "on"
        ? "thinking on"
        : null;
  if (reasoning === null) return null;

  return rowOf("fastMode")?.value === "on" ? `${reasoning} ⚡` : reasoning;
};
