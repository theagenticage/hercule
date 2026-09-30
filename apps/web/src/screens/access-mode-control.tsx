import type { JSX } from "react";
import { formatAccessMode } from "@hercule/client-core";
import { ACCESS_MODE_CHAIN, type AccessMode } from "@hercule/contract";
import { SegmentedControl, SegmentedControlItem } from "@hercule/ui";

/**
 * Renders a segmented control named "Access mode" that picks one of the four
 * access modes, in the compact style for the value column of a settings
 * `Row`. Each segment shows the mode's name, and `onChange` receives the
 * picked mode's value.
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
      {ACCESS_MODE_CHAIN.map((mode) => (
        <SegmentedControlItem key={mode} value={mode}>
          {formatAccessMode(mode)}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
