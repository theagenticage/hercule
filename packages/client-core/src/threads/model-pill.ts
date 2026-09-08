/**
 * The composer's model pill: `<displayName> · <instance name> · <slug>`, with
 * a fourth segment for the model's reasoning effort when it has one - the
 * well-known `effort` option id (spec 06 §3.3) - reading the option's chosen
 * choice label rather than its raw value, since a pill is copy, not a slug.
 */
import type { ModelOption } from "@hydra/contract";

export const modelPillLabel = (
  instance: { readonly displayName: string; readonly name: string },
  model: string,
  options: readonly ModelOption[],
  selected: Readonly<Record<string, string | boolean>>,
): string => {
  const base = `${instance.displayName} · ${instance.name} · ${model}`;
  const effort = options.find((option) => option.id === "effort");
  if (effort === undefined) return base;

  const value = selected[effort.id] ?? effort.default;
  const label =
    effort.kind === "select"
      ? (effort.choices?.find((choice) => choice.value === value)?.label ?? String(value))
      : value
        ? "on"
        : "off";
  return `${base} · ${label}`;
};
