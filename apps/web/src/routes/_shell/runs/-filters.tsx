import type { JSX } from "react";
import {
  RUN_STATUSES,
  type RunFilter,
  type RunStatus,
  type WorkflowSummary,
} from "@hercule/contract";
import { Button, Field, Select } from "@hercule/ui";

/** The value every filter starts on, which means no filter. */
const ANY = "";

/** Returns the run filter for the two selects' values, leaving out a select on Any. */
const buildFilter = (workflowId: string, status: RunStatus | typeof ANY): RunFilter => ({
  ...(workflowId === ANY ? {} : { workflowId }),
  ...(status === ANY ? {} : { status }),
});

/**
 * The filter bar above the run list, with the button that opens the run form.
 * Both filters start on Any, so the screen shows every run until the user
 * narrows it, and each applies at once.
 */
export function RunFilterBar({
  value,
  workflows,
  onChange,
  onRun,
}: {
  readonly value: RunFilter;
  readonly workflows: ReadonlyArray<WorkflowSummary>;
  readonly onChange: (next: RunFilter) => void;
  readonly onRun: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-[220px]">
        <Field id="filter-workflow" label="Workflow">
          <Select
            id="filter-workflow"
            value={value.workflowId ?? ANY}
            onChange={(event) => {
              onChange(buildFilter(event.target.value, value.status ?? ANY));
            }}
          >
            <option value={ANY}>Any workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="w-[150px]">
        <Field id="filter-status" label="Status">
          <Select
            id="filter-status"
            value={value.status ?? ANY}
            onChange={(event) => {
              onChange(buildFilter(value.workflowId ?? ANY, event.target.value as RunStatus));
            }}
          >
            <option value={ANY}>Any status</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="ml-auto pb-1">
        <Button variant="form" onClick={onRun}>
          Run workflow
        </Button>
      </div>
    </div>
  );
}
