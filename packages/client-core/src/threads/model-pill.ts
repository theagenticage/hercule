/**
 * The composer's model pill: `<displayName> · <instance name> · <slug>`, with
 * a fourth segment for the model's reasoning effort when it has one - the
 * well-known `effort` option id (spec 06 §3.3) - reading the option's chosen
 * choice label rather than its raw value, since a pill is copy, not a slug.
 *
 * Joins only the parts it has: an instance not logged in on the reference
 * runner has no model yet (`null`), and a pill built from no slug at all is
 * not a third part, it is a dangling " · " between the other two.
 */
import type { ModelOption } from "@hydra/contract";

const effortLabel = (
  effort: ModelOption,
  selected: Readonly<Record<string, string | boolean>>,
): string => {
  const value = selected[effort.id] ?? effort.default;
  return effort.kind === "select"
    ? (effort.choices?.find((choice) => choice.value === value)?.label ?? String(value))
    : value
      ? "on"
      : "off";
};

export const modelPillLabel = (
  instance: { readonly displayName: string; readonly name: string },
  model: string | null,
  options: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): string => {
  const effort = options.find((option) => option.id === "effort");
  return [
    instance.displayName,
    instance.name,
    model,
    effort === undefined ? null : effortLabel(effort, selected),
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
};
