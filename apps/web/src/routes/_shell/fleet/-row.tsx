import type { JSX } from "react";
import { cn } from "@hydra/ui";
import { formatBytes, formatStamp } from "@hydra/client-core";
import type { Runner, RunnerConnectivity } from "@hydra/contract";

/**
 * Only `online` is live and only `unreachable` was nobody's choice. The
 * attention hue is left free for the skew warning, the one actionable thing here.
 */
const CONNECTIVITY_HUE: Record<RunnerConnectivity, string> = {
  online: "text-live",
  offline: "text-muted",
  unreachable: "text-fail",
};

/** In the order a person scans it. */
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
 * A skewed binary is called out rather than left as two numbers to compare,
 * because a fleet is scanned. Labels sit apart from the probed facts, since
 * reading `gpu` as something the machine found would be backwards, and a machine
 * that is not connected carries how long ago its row was true.
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
    runner.connectivity === "online" || runner.lastSeenAt === null
      ? undefined
      : formatStamp(new Date(runner.lastSeenAt), timezone);
  return (
    <div className="rounded-control px-2.5 py-[7px]">
      <div className="flex items-baseline gap-2.5 text-row">
        <span className="min-w-0 flex-1 truncate">
          <b className="font-emph text-ink">{runner.name}</b>
          {isLocal ? <small className="ml-1.5 text-fine text-muted">this machine</small> : null}
        </span>
        {/* `active` is the ordinary one; saying so on every row would be noise. */}
        {runner.lifecycle === "active" ? null : (
          <span className="text-fine text-faint">{runner.lifecycle}</span>
        )}
        <span
          className={cn(
            "flex items-center gap-1.5 text-fine",
            CONNECTIVITY_HUE[runner.connectivity],
          )}
        >
          {runner.connectivity === "online" ? (
            <span
              aria-hidden="true"
              className="hydra-live-dot size-1.5 shrink-0 rounded-full bg-live"
            />
          ) : null}
          {runner.connectivity}
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
