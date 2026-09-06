import type { JSX } from "react";
import { Row } from "@hydra/ui";
import { runnerFactsReading, type RunnerFactsReading } from "@hydra/client-core";
import type { RunnerDetail } from "@hydra/contract";

/** The lines, in the order a page states them. */
const LINES: ReadonlyArray<readonly [string, keyof RunnerFactsReading]> = [
  ["Machine", "machine"],
  ["Memory", "memory"],
  ["Disk free", "diskFree"],
  ["Toolchains", "toolchains"],
  ["Providers", "providers"],
  ["Docker", "docker"],
  ["Binary", "binary"],
];

/**
 * What the machine reported about itself, one labelled line per kind of fact.
 *
 * A fleet row runs these together because it is scanned; a page is read, so
 * each is named. Nothing here is editable: it is the machine's own report, and
 * the only way to change it is to make the machine report again.
 */
export function RunnerFacts({ runner }: { readonly runner: RunnerDetail }): JSX.Element {
  const reading = runnerFactsReading(runner);

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
