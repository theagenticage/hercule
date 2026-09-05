import type { JSX } from "react";
import { cn } from "@hydra/ui";
import { formatBytes, formatStamp } from "@hydra/client-core";
import type { Runner, RunnerState } from "@hydra/contract";

/**
 * The grey or hue a state word is read in. Only `online` is a machine doing
 * anything, so only it is live, and `unreachable` is the one state nobody
 * chose. The attention hue is left free for the skew warning, which is the one
 * thing on this screen a person can act on.
 */
const STATE_HUE: Record<RunnerState, string> = {
  online: "text-live",
  offline: "text-muted",
  unreachable: "text-fail",
  draining: "text-muted",
  retired: "text-faint",
};

/** What a machine probed about itself, in the order a person scans it. */
const probed = (runner: Runner): ReadonlyArray<string> => [
  ...(runner.facts === null
    ? []
    : [
        runner.facts.os,
        runner.facts.arch,
        `${formatBytes(runner.facts.totalMemoryBytes)} memory`,
        ...runner.facts.toolchains.map((tool) => `${tool.name} ${tool.version}`),
      ]),
  ...(runner.watermark === null
    ? []
    : [`${formatBytes(runner.watermark.diskFreeBytes)} disk free`]),
];

/**
 * One machine: what it is on the first line, what it reported on the second.
 *
 * A binary that is not the controller's is called out rather than left as two
 * numbers to compare, because a fleet is scanned and skew is the one thing here
 * that needs doing something about. Labels sit apart from the probed facts: a
 * label is what a person wrote on the machine, and reading `gpu` as something
 * the machine found would be backwards. A machine that is not connected carries
 * how long ago it was, because everything else on its row was true then and
 * nothing says whether it is true now.
 */
export function RunnerRow({
  runner,
  controllerVersion,
  isLocal,
  timezone,
}: {
  readonly runner: Runner;
  readonly controllerVersion: string;
  readonly isLocal: boolean;
  readonly timezone: string;
}): JSX.Element {
  const skewed = runner.version !== null && runner.version !== controllerVersion;
  const facts = probed(runner);
  const lastSeen =
    runner.state === "online" || runner.lastSeenAt === null
      ? undefined
      : formatStamp(new Date(runner.lastSeenAt), timezone);
  return (
    <div className="rounded-control px-2.5 py-[7px]">
      <div className="flex items-baseline gap-2.5 text-row">
        <span className="min-w-0 flex-1 truncate">
          <b className="font-emph text-ink">{runner.name}</b>
          {isLocal ? <small className="ml-1.5 text-fine text-muted">this machine</small> : null}
        </span>
        <span className={cn("flex items-center gap-1.5 text-fine", STATE_HUE[runner.state])}>
          {runner.state === "online" ? (
            <span
              aria-hidden="true"
              className="hydra-live-dot size-1.5 shrink-0 rounded-full bg-live"
            />
          ) : null}
          {runner.state}
          {lastSeen === undefined ? null : <span className="text-faint">last seen {lastSeen}</span>}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5 pt-px text-fine">
        {runner.version === null ? (
          <span className="text-faint">has not reported yet</span>
        ) : (
          <span className={skewed ? "text-attn" : "text-muted"}>
            {runner.version}
            {skewed ? ` · differs from the controller's ${controllerVersion}` : ""}
          </span>
        )}
        {facts.length === 0 ? null : <span className="text-faint">· {facts.join(" · ")}</span>}
        {runner.labels.length === 0 ? null : (
          <span className="text-muted">· {runner.labels.join(", ")}</span>
        )}
      </div>
    </div>
  );
}
