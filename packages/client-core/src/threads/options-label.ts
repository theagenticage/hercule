/**
 * The model options selector's own label: what is picked under the model, in
 * one word. Reads the choice's label rather than its value, because a label is
 * copy and a value is a slug. It says nothing at all where there is no word
 * to say - no reasoning choice, or one that is off - and the selector then
 * carries its own name: a bolt on its own would name nothing.
 */
import type { ModelOption } from "@hydra/contract";

type Selected = Readonly<Record<string, string | boolean>>;

const valueOf = (option: ModelOption, selected: Selected): string | boolean =>
  selected[option.id] ?? option.default;

const effortLabel = (option: ModelOption, selected: Selected): string => {
  const value = valueOf(option, selected);
  return (
    option.choices?.find((choice) => choice.value === value)?.label ?? String(value)
  ).toLowerCase();
};

export const optionsLabel = (
  descriptors: readonly ModelOption[],
  selected: Selected,
): string | null => {
  const effort = descriptors.find((option) => option.id === "effort");
  const thinking = descriptors.find((option) => option.id === "thinking");
  const fastMode = descriptors.find((option) => option.id === "fastMode");

  const reasoning =
    effort !== undefined
      ? effortLabel(effort, selected)
      : thinking !== undefined
        ? valueOf(thinking, selected) === true
          ? "thinking on"
          : null
        : null;
  if (reasoning === null) return null;

  const fast = fastMode !== undefined && valueOf(fastMode, selected) === true;
  return fast ? `${reasoning} ⚡` : reasoning;
};
