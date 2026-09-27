import type { ComponentProps, JSX } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { cn } from "./cn";

/**
 * Renders a control that switches between two or more views of one surface.
 * One is always selected.
 *
 * `compact` is the style for a control in the value column of a settings
 * `Row`. The control fills the column like the selects above and below it,
 * and the segments get smaller text and less padding, so that the longest
 * labels, such as the four access modes, fit without breaking a word.
 *
 * A compact segment is sized to its label, and the spare room is shared out
 * equally. Equal-width segments would squeeze long labels against the
 * control's edge and give the spare room to the short ones. With two labels
 * of similar length, the two rules look the same.
 */
export function SegmentedControl({
  compact = false,
  className,
  value,
  onValueChange,
  ...props
}: Omit<ComponentProps<"div">, "defaultValue" | "dir" | "onChange"> & {
  compact?: boolean;
  value: string;
  onValueChange: (value: string) => void;
}): JSX.Element {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      // Radix reports "" when the pressed item is the one already on; the
      // segmented control has no off state, so that press is a no-op.
      onValueChange={(next) => {
        if (next !== "") onValueChange(next);
      }}
      className={cn(
        "inline-flex w-full gap-0.5 rounded-control border border-line-soft bg-surface p-0.5",
        compact && "[&>button]:flex-auto [&>button]:px-1.5 [&>button]:text-fine",
        className,
      )}
      {...props}
    />
  );
}

export function SegmentedControlItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroup.Item>): JSX.Element {
  return (
    <ToggleGroup.Item
      className={cn(
        "flex-1 cursor-pointer rounded-[4px] px-2 py-1 text-meta whitespace-nowrap text-muted",
        "hover:text-ink",
        "data-[state=on]:bg-raised data-[state=on]:text-ink data-[state=on]:font-emph data-[state=on]:shadow-card",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        className,
      )}
      {...props}
    />
  );
}
