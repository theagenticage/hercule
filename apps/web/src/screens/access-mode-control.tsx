import type { JSX } from "react";
import type { AccessMode } from "@hercule/contract";
import { SegmentedControl, SegmentedControlItem } from "@hercule/ui";

/** The four access modes, from the most asking to the least. */
const ACCESS_MODES: readonly AccessMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * Renders a segmented control named "Access mode" that picks one of the four
 * access modes, in the compact style for the value column of a settings
 * `Row`. `onChange` receives the picked mode.
 */
export function AccessModeControl({
  value,
  onChange,
}: {
  readonly value: AccessMode;
  readonly onChange: (mode: AccessMode) => void;
}): JSX.Element {
  return (
    <SegmentedControl
      aria-label="Access mode"
      compact
      value={value}
      onValueChange={(next) => {
        onChange(next as AccessMode);
      }}
    >
      {ACCESS_MODES.map((mode) => (
        // The four labels differ in length and together nearly fill the
        // column. Equal-width segments leave the long labels only the
        // minimum padding, their text almost touching the control's edge, and
        // give the spare room to "auto". Sizing each segment to its label
        // shares the spare room out equally instead.
        <SegmentedControlItem key={mode} value={mode} className="flex-auto">
          {mode}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
