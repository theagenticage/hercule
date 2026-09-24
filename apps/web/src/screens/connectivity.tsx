import type { JSX } from "react";
import { cn } from "@hercule/ui";
import { formatStamp } from "@hercule/client-core";
import type { Runner } from "@hercule/contract";

/**
 * The text colour per connectivity state. Only `online` gets the live colour,
 * and only `unreachable` gets the failure colour, because no one chose it.
 * The attention colour is not used, so that it stays reserved for the fleet
 * row's version skew warning, the one thing there the user can act on.
 */
const HUE: Record<Runner["connectivity"], string> = {
  online: "text-live",
  offline: "text-muted",
  unreachable: "text-fail",
};

/**
 * Shows whether the controller can reach a machine, the same way everywhere:
 * a live dot while the connection is up, and when the machine was last seen
 * while it is not.
 */
export function Connectivity({
  runner,
  timezone,
}: {
  readonly runner: Runner;
  readonly timezone: string;
}): JSX.Element {
  const live = runner.connectivity === "online";
  const lastSeen = live || runner.lastSeenAt === null ? null : runner.lastSeenAt;

  return (
    <span className={cn("flex items-center gap-1.5 text-fine", HUE[runner.connectivity])}>
      {live ? (
        <span
          aria-hidden="true"
          className="hercule-live-dot size-1.5 shrink-0 rounded-full bg-live"
        />
      ) : null}
      {runner.connectivity}
      {lastSeen === null ? null : (
        <span className="text-faint">last seen {formatStamp(new Date(lastSeen), timezone)}</span>
      )}
    </span>
  );
}
