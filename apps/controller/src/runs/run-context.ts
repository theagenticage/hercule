/**
 * The context a run's conditions and templates are evaluated against. Routing
 * evaluates conditions in it, and a step renders its params in it.
 */
import type { Run } from "@hercule/contract";

/**
 * Builds the context that conditions and templates are evaluated against:
 * the run's `inputs`, and under `steps.<id>` the output of each step's latest
 * finished iteration. A step is absent from `steps` when it has not finished
 * yet, when it never runs, and when its latest finished iteration was
 * skipped, even if an earlier one completed. So `has(steps.x)` tells whether
 * the latest `x` produced an output.
 */
export const buildRunContext = (run: Pick<Run, "inputs" | "steps">): Record<string, unknown> => {
  const latest = new Map<string, Run["steps"][number]>();
  for (const record of run.steps) {
    if (record.status !== "completed" && record.status !== "skipped") continue;
    const known = latest.get(record.stepId);
    if (known === undefined || known.iteration < record.iteration) {
      latest.set(record.stepId, record);
    }
  }
  const steps: Record<string, unknown> = {};
  for (const [stepId, record] of latest) {
    if (record.status === "completed") steps[stepId] = { output: record.output };
  }
  return { inputs: run.inputs, steps };
};
