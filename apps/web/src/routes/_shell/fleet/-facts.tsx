import type { JSX } from "react";
import { Row } from "@hydra/ui";
import { runnerFactsReading, type RunnerFactsReading } from "@hydra/client-core";
import type { RunnerDetail } from "@hydra/contract";

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
 * What the machine reported about itself. A fleet row runs these together
 * because it is scanned; a page is read, so each fact is named. None of it is
 * editable: the only way to change it is to make the machine report again.
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
