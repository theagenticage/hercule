import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeRunnerFacts } from "@hercule/client-core";
import type { Runner } from "@hercule/contract";
import { Connectivity } from "../../../screens/connectivity";

/**
 * Returns the runner's probed facts for its row, in the order a person scans
 * them, leaving out the ones not reported yet. The row joins them into one
 * line, so the two sizes say what they measure; on the runner page each fact
 * has its own label instead.
 */
const listProbedFacts = (runner: Runner): ReadonlyArray<string> => {
  const reading = describeRunnerFacts(runner);
  return [
    reading.machine,
    reading.memory === null ? null : `${reading.memory} memory`,
    reading.toolchains,
    reading.diskFree === null ? null : `${reading.diskFree} disk free`,
  ].filter((fact): fact is string => fact !== null);
};

/**
 * The row for one runner on the fleet screen.
 *
 * - A runner whose version differs from the controller's gets a note, rather
 *   than two numbers the reader has to compare, because the fleet is scanned.
 * - The note has its own line. It is a sentence, not a fact, and when it
 *   wrapped among the facts it pushed them onto a second line that started
 *   with a separator.
 * - Labels are on their own line, apart from the probed facts, so a label like
 *   `gpu` is not mistaken for something the machine reported.
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
  const facts = listProbedFacts(runner);

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
        {/* `active` is the ordinary lifecycle; showing it on every row would be noise. */}
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
