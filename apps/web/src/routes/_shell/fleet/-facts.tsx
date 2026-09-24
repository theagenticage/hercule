import type { JSX } from "react";
import { Row } from "@hercule/ui";
import { describeRunnerFacts, type RunnerFactsReading } from "@hercule/client-core";
import type { RunnerDetail } from "@hercule/contract";

const LINES: ReadonlyArray<readonly [string, keyof RunnerFactsReading]> = [
  ["Machine", "machine"],
  ["Memory", "memory"],
  ["Disk free", "diskFree"],
  ["Toolchains", "toolchains"],
  // Not "Providers": the card below uses that word for provider instances,
  // and this line lists the binaries the machine found on its PATH.
  ["Harnesses", "providers"],
  ["Docker", "docker"],
  ["Binary", "binary"],
];

/**
 * The facts the machine reported about itself, one labelled line each. A
 * fleet row joins them into one line for scanning; this page labels each one.
 * None of them are editable: they change only when the machine reports again.
 */
export function RunnerFacts({ runner }: { readonly runner: RunnerDetail }): JSX.Element {
  const reading = describeRunnerFacts(runner);

  return (
    <div className="flex flex-col gap-1.5">
      {LINES.map(([label, key]) => (
        <Row key={key} label={label}>
          {reading[key] === null ? (
            <span className="text-row text-faint">has not reported yet</span>
          ) : (
            <span className="text-row text-ink">{reading[key]}</span>
          )}
        </Row>
      ))}
    </div>
  );
}
