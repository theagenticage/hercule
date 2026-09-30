import { Fragment, type JSX } from "react";
import { buildOptionsMenu, parseOptionChoice } from "@hercule/client-core";
import type { ModelOption } from "@hercule/contract";
import { SegmentedControl, SegmentedControlItem } from "@hercule/ui";
import { MenuHeader } from "./menu";
import { SelectorShell } from "./selector-shell";

const HEADER = "Model options";

/**
 * The selector for the model's options: one labelled segmented control per
 * option the model declares, shown as declared. There is no free-text entry,
 * because the provider defines the choices.
 *
 * The trigger shows the current value (`high ⚡`) rather than a name, at a
 * fixed minimum width, so the model pill beside it does not move when the
 * value changes.
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
  /** The current value in one word, or null to show the "Model options" header as the label. */
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
        {buildOptionsMenu(descriptors, selected).map((row) => (
          <Fragment key={row.id}>
            <span className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase">
              {row.label}
            </span>
            <SegmentedControl
              aria-label={row.label}
              className="w-auto flex-wrap gap-px rounded-none border-0 bg-transparent p-0"
              value={row.value}
              onValueChange={(next) => {
                onPick(row.id, parseOptionChoice(row, next));
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
