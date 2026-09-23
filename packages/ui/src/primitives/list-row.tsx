import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * One row of a list. Pressing it opens something, so it is a button. It uses
 * no colour.
 *
 * `dimmed` fades the row, for finished or unimportant work. It lowers the
 * opacity instead of using a paler ink, so everything in the row fades
 * together.
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
