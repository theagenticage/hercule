import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import {
  changeRunnerLabels,
  formatDiskLimit,
  parseDiskLimit,
  parseSessionCap,
  type LabelChange,
} from "@hercule/client-core/machine-page";
import type { Runner } from "@hercule/contract";
import { MachinePageSection } from "../../../../screens/fleet/machine-page-section";
import {
  MachineLabelsRow,
  MachineNumberRow,
  MachineRetireRow,
  MachineSwitchRow,
} from "../../../../screens/fleet/machine-page-settings";
import { useSavedRunnerDrain, useSavedRunnerField } from "./-saved-runner-field";

/** Returns the change as the new value, for a field that holds one value and replaces it whole. */
const replaceValue = <Value,>(_shown: Value, change: Value): Value => change;

/**
 * Renders the Settings section of the machine `runner`'s page (spec 17
 * §Fleet, A machine's page): the session cap, the labels, whether the machine
 * is reserved, its disk limit, Stop new work and Retire. Each row saves as
 * Settings' rows do: on every change, with the failed save's message under
 * its row and the control put back.
 *
 * - Text the user typed that does not parse is refused under its row by the
 *   row itself, and nothing is sent.
 * - The disk limit shows gigabytes of 10^9 bytes with one decimal, which is
 *   rounded: the default 10 GiB reads "10.7". The field saves only when its
 *   text changed, so leaving it alone never rewrites the stored limit.
 * - Retire… calls `onRetire`; the page asks the question.
 */
export function MachineSettings({
  id,
  runner,
  onRetire,
}: {
  readonly id: string;
  readonly runner: Runner;
  readonly onRetire: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;

  const cap = useSavedRunnerField<number, number>(
    client,
    runner.id,
    runner.maxConcurrentSessions,
    replaceValue,
    (latest, change) =>
      change === latest.maxConcurrentSessions ? {} : { maxConcurrentSessions: change },
  );
  const labels = useSavedRunnerField<readonly string[], LabelChange>(
    client,
    runner.id,
    runner.labels,
    changeRunnerLabels,
    (latest, change) => {
      const next = changeRunnerLabels(latest.labels, change);
      return next.length === latest.labels.length ? {} : { labels: [...next] };
    },
  );
  const reserved = useSavedRunnerField<boolean, boolean>(
    client,
    runner.id,
    runner.reserved,
    replaceValue,
    (latest, change) => (change === latest.reserved ? {} : { reserved: change }),
  );
  const diskLimit = useSavedRunnerField<number, number>(
    client,
    runner.id,
    runner.diskWatermarkBytes,
    replaceValue,
    (latest, change) =>
      change === latest.diskWatermarkBytes ? {} : { diskWatermarkBytes: change },
  );
  const draining = useSavedRunnerDrain(client, runner);

  return (
    <MachinePageSection id={id} title="Settings">
      <MachineNumberRow
        label="Session cap"
        hint="How many sessions run here at once."
        inputMode="numeric"
        value={String(cap.value)}
        error={cap.error}
        parse={parseSessionCap}
        onSave={cap.save}
      />
      <MachineLabelsRow
        labels={labels.value}
        error={labels.error}
        onAdd={(label) => labels.save({ kind: "add", label })}
        onRemove={(label) => labels.save({ kind: "remove", label })}
      />
      <MachineSwitchRow
        label="Reserved"
        hint="Runs only the work that names this machine."
        checked={reserved.value}
        error={reserved.error}
        onToggle={() => reserved.save(!reserved.value)}
      />
      <MachineNumberRow
        label="Disk limit"
        hint="Below this much free space, it takes no new sessions."
        unit="GB"
        inputMode="decimal"
        value={formatDiskLimit(diskLimit.value)}
        error={diskLimit.error}
        parse={parseDiskLimit}
        onSave={diskLimit.save}
      />
      <MachineSwitchRow
        label="Stop new work"
        hint="Sessions running here finish; nothing new starts."
        checked={draining.value}
        error={draining.error}
        onToggle={() => draining.save(!draining.value)}
      />
      <MachineRetireRow onRetire={onRetire} />
    </MachinePageSection>
  );
}
