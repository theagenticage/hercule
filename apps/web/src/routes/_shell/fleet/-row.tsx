import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { runnerFactsReading } from "@hercule/client-core";
import type { Runner } from "@hercule/contract";
import { Connectivity } from "../../../screens/connectivity";

/**
 * In the order a person scans it. A row runs the facts together, so the two
 * sizes carry what they are: on the page each has a label of its own.
 */
const probed = (runner: Runner): ReadonlyArray<string> => {
  const reading = runnerFactsReading(runner);
  return [
    reading.machine,
    reading.memory === null ? null : `${reading.memory} memory`,
    reading.toolchains,
    reading.diskFree === null ? null : `${reading.diskFree} disk free`,
  ].filter((fact): fact is string => fact !== null);
};

/**
 * A skewed binary is called out rather than left as two numbers to compare,
 * because a fleet is scanned. Labels sit apart from the probed facts, since
 * reading `gpu` as something the machine found would be backwards.
 *
 * The skew note takes a line of its own: it is a sentence rather than a fact,
 * and left to wrap among the facts it pushed them onto a second line that began
 * with a separator and no subject.
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

  return (
    <Link
      to="/fleet/$runnerId"
      params={{ runnerId: runner.id }}
      className="block rounded-control px-2.5 py-[7px] hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      <div className="flex items-baseline gap-2.5 text-row">
        <span className="min-w-0 flex-1 truncate">
          <b className="font-emph text-ink">{runner.name}</b>
          {isLocal ? <small className="ml-1.5 text-fine text-muted">this machine</small> : null}
        </span>
        {/* `active` is the ordinary one; saying so on every row would be noise. */}
        {runner.lifecycle === "active" ? null : (
          <span className="text-fine text-faint">{runner.lifecycle}</span>
        )}
        <Connectivity runner={runner} timezone={timezone} />
      </div>

      {skewed ? (
        <div className="pt-px text-fine text-attn">
          {runner.version} · differs from the controller&apos;s {controllerVersion}
        </div>
      ) : null}

      <div className="pt-px text-fine">
        {runner.version === null ? (
          <span className="text-faint">has not reported yet</span>
        ) : skewed ? null : (
          <span className="text-muted">{runner.version}</span>
        )}
        {facts.length === 0 ? null : (
          <span className="text-faint">
            {runner.version === null || skewed ? "" : " · "}
            {facts.join(" · ")}
          </span>
        )}
      </div>

      {runner.labels.length === 0 ? null : (
        <div className="pt-px text-fine text-muted">{runner.labels.join(", ")}</div>
      )}
    </Link>
  );
}
