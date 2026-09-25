/**
 * Checks about whether a run and its step records can still change, which
 * the run engine and its routing rules share.
 */
import type { RunStatus, StepRecord, StepStatus } from "@hercule/contract";

/**
 * Checks whether a run or a step record can still change: it is pending or
 * running. Only such a run is executed, cancelled or resumed at boot. A run
 * and a step record share these two statuses, so this one check serves both.
 */
export const isUnfinished = (status: RunStatus | StepStatus): boolean =>
  status === "pending" || status === "running";

/** A step record that can still change: one that is pending or running. */
export type UnfinishedStepRecord = Extract<StepRecord, { readonly status: "pending" | "running" }>;

/** Checks whether a step record is pending or running. */
const isUnfinishedRecord = (record: StepRecord): record is UnfinishedStepRecord =>
  isUnfinished(record.status);

/**
 * Returns the next record of each step that has one: the step's first record,
 * in the order they were created, that has not ended. A step's records are
 * created and executed in iteration order, so its next record is its running
 * one if it has one, and otherwise its pending one with the lowest iteration.
 * The records are returned in the order they were created; a run whose
 * records have all ended gets an empty list.
 */
export const listNextStepRecords = (
  steps: ReadonlyArray<StepRecord>,
): ReadonlyArray<UnfinishedStepRecord> => {
  const next = new Map<string, UnfinishedStepRecord>();
  for (const record of steps) {
    if (isUnfinishedRecord(record) && !next.has(record.stepId)) next.set(record.stepId, record);
  }
  return [...next.values()];
};
