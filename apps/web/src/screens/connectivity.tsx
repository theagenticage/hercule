import type { JSX } from "react";
import { cn } from "@hydra/ui";
import { formatStamp } from "@hydra/client-core";
import type { Runner } from "@hydra/contract";

/**
 * Only `online` is live and only `unreachable` was nobody's choice. The
 * attention hue is left free for the fleet row's skew warning, the one
 * actionable thing there.
 */
const HUE: Record<Runner["connectivity"], string> = {
  online: "text-live",
  offline: "text-muted",
  unreachable: "text-fail",
};

/**
 * Whether the controller can reach a machine, drawn the same way wherever it is
 * read: a live dot only while the socket is up, and how long ago the row was
 * true whenever it is not.
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
          className="hydra-live-dot size-1.5 shrink-0 rounded-full bg-live"
        />
      ) : null}
      {runner.connectivity}
      {lastSeen === null ? null : (
        <span className="text-faint">last seen {formatStamp(new Date(lastSeen), timezone)}</span>
      )}
    </span>
  );
}
