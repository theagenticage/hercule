import type { JSX } from "react";
import { computeMemoryFill, formatMemoryUsage } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * Renders how full a memory document is: a thin meter, and the count beside
 * it, "1,284 of 4,000".
 *
 * The meter is drawn in ink, never in a hue, like every other mark of
 * quantity. Over the cap the count turns to the failed hue, because the
 * controller will refuse that write; the meter is already full.
 */
export function MemoryUsage({
  label,
  size,
  cap,
}: {
  /** The meter's accessible name, such as "Core memory used". */
  readonly label: string;
  readonly size: number;
  readonly cap: number;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(size, cap)}
        className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full rounded-full bg-muted"
          style={{ width: `${String(computeMemoryFill(size, cap) * 100)}%` }}
        />
      </div>
      <span
        className={cn(
          "shrink-0 font-mono text-fine tabular-nums",
          size > cap ? "text-fail" : "text-faint",
        )}
      >
        {formatMemoryUsage(size, cap)}
      </span>
    </div>
  );
}
