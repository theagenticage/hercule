import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * One row of a list that opens something.
 *
 * A row is a button, because that is what it does; the hue-free treatment is
 * all it carries. `dimmed` is the recession finished and unimportant work
 * takes, and it is opacity rather than a paler ink so everything in the row
 * recedes together.
 */
export function ListRow({
  dimmed = false,
  selected = false,
  type = "button",
  className,
  ...props
}: ComponentProps<"button"> & {
  readonly dimmed?: boolean;
  readonly selected?: boolean;
}): JSX.Element {
  return (
    <button
      type={type}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-control px-2.5 py-2 text-left text-row",
        "hover:bg-line-soft",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        selected && "bg-line-soft",
        dimmed && "opacity-66",
        className,
      )}
      {...props}
    />
  );
}
