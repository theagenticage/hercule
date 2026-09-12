import { Fragment, type JSX } from "react";
import type { ModelOption } from "@hydra/contract";
import { SegmentedControl, SegmentedControlItem } from "@hydra/ui";
import { SelectorShell } from "./selector-shell";

const HEADER = "Model options";

/** A boolean descriptor is a two-way switch, and reads as one. */
const SWITCH = [
  { value: "off", label: "off" },
  { value: "on", label: "on" },
];

const choicesOf = (option: ModelOption): ReadonlyArray<{ value: string; label: string }> =>
  option.kind === "boolean" ? SWITCH : (option.choices ?? []);

/**
 * What is picked under the model: one labelled segmented row per descriptor
 * the model declares, verbatim - no free-text entry anywhere, since the
 * choices are the provider's own.
 *
 * The selector wears its own value (`high ⚡`) rather than a name, at a fixed
 * minimum width, so the pill beside it never moves as the value changes.
 */
export function ModelOptionsSelector({
  descriptors,
  selected,
  label,
  modelName,
  disabled,
  open,
  onOpenChange,
  onPick,
}: {
  readonly descriptors: readonly ModelOption[];
  readonly selected: Readonly<Record<string, string | boolean>>;
  /** The value in one word, or nothing to say - then the selector names itself. */
  readonly label: string | null;
  readonly modelName: string | null;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (id: string, value: string | boolean) => void;
}): JSX.Element {
  return (
    <SelectorShell
      label={label ?? HEADER}
      locked={null}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      className="ml-auto min-w-[84px] justify-between text-ink"
    >
      <div className="flex items-baseline gap-2 px-2 pt-1.5 pb-[5px]">
        <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">{HEADER}</span>
        <span className="ml-auto font-mono text-[10.5px] whitespace-nowrap text-faint">
          {modelName}
        </span>
      </div>
      <div className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 px-2 pt-1.5 pb-1">
        {descriptors.map((option) => {
          const value = selected[option.id] ?? option.default;
          return (
            <Fragment key={option.id}>
              <span className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase">
                {option.label}
              </span>
              <SegmentedControl
                aria-label={option.label}
                value={option.kind === "boolean" ? (value === true ? "on" : "off") : String(value)}
                onValueChange={(next) => {
                  onPick(option.id, option.kind === "boolean" ? next === "on" : next);
                }}
              >
                {choicesOf(option).map((choice) => (
                  <SegmentedControlItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </Fragment>
          );
        })}
      </div>
    </SelectorShell>
  );
}
