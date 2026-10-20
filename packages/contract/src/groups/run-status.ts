import { Schema } from "effect";

/**
 * The statuses of a run, in the order a run moves through them. They live in
 * a file of their own so that the task group can name a run's status without
 * importing the run group, which imports the task group's constants.
 */
export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

export const RunStatus = Schema.Literals(RUN_STATUSES);

export type RunStatus = Schema.Schema.Type<typeof RunStatus>;
