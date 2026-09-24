import type { ComponentProps, JSX } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { cn } from "./cn";

/** A control that switches between two or more views of one surface. One is always selected. */
export function SegmentedControl({
  className,
  value,
  onValueChange,
  ...props
}: Omit<ComponentProps<"div">, "defaultValue" | "dir" | "onChange"> & {
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
