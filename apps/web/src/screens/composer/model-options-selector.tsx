import { Fragment, type JSX } from "react";
import { optionsMenu } from "@hercule/client-core";
import type { ModelOption } from "@hercule/contract";
import { SegmentedControl, SegmentedControlItem } from "@hercule/ui";
import { MenuHeader } from "./menu";
import { SelectorShell } from "./selector-shell";

const HEADER = "Model options";

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
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      className="ml-auto min-w-[84px] justify-between text-ink"
    >
      <MenuHeader label={HEADER} note={modelName ?? undefined} />
      <div className="mt-0.5 grid grid-cols-[68px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-[5px] px-2 pt-1.5 pb-1">
        {optionsMenu(descriptors, selected).map((row) => (
          <Fragment key={row.id}>
            <span className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase">
              {row.label}
            </span>
            <SegmentedControl
              aria-label={row.label}
              className="w-auto flex-wrap gap-px rounded-none border-0 bg-transparent p-0"
              value={row.value}
              onValueChange={(next) => {
                onPick(row.id, row.boolean ? next === "on" : next);
              }}
            >
              {row.choices.map((choice) => (
                <SegmentedControlItem
                  key={choice.value}
                  value={choice.value}
                  className="flex-none rounded-[5px] px-2 py-[3px] text-[12px] hover:bg-line-soft data-[state=on]:bg-line-soft data-[state=on]:shadow-none"
                >
                  {choice.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Fragment>
        ))}
      </div>
    </SelectorShell>
  );
}
