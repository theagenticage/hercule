/**
 * Editing and retiring a runner: turning a form draft into a patch, finding
 * which field a `conflict` error belongs to, and deciding what to warn about
 * before a runner is retired. These rules live here with a test rather than
 * in a component.
 */
import type { Runner, RunnerUpdateInput } from "@hercule/contract";
import { ApiError } from "./errors";

/** The five editable fields of a runner, as the form holds them. */
export interface RunnerDraft {
  readonly name: string;
  readonly labels: ReadonlyArray<string>;
  readonly maxConcurrentSessions: number;
  readonly diskWatermarkBytes: number;
  readonly reserved: boolean;
}

/** Returns the draft the form starts with: the runner's current values. */
export const buildRunnerDraft = (runner: Runner): RunnerDraft => ({
  name: runner.name,
  labels: runner.labels,
  maxConcurrentSessions: runner.maxConcurrentSessions,
  diskWatermarkBytes: runner.diskWatermarkBytes,
  reserved: runner.reserved,
});

/** Labels are replaced whole, so their order is part of the value. */
const areLabelsEqual = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);

/**
 * Returns a patch with only the fields the draft changed.
 *
 * A patch field that equals the runner's current value is still a write: it
 * is stamped with an actor and adds an audit row. Sending only the changed
 * fields keeps the audit trail readable, and an empty patch tells the form
 * that nothing was edited.
 *
 * The name is trimmed here and nowhere else. So adding spaces around a name
 * is not a change, but a name the user has cleared is. The form does not
 * submit an empty name, and because the draft still differs from the runner,
 * a fresh read of the runner does not refill the field while the user edits
 * it.
 */
export const buildRunnerPatch = (runner: Runner, draft: RunnerDraft): RunnerUpdateInput => {
  const patch: { -readonly [K in keyof RunnerUpdateInput]: RunnerUpdateInput[K] } = {};
  const name = draft.name.trim();
  if (name !== runner.name) patch.name = name;
  if (!areLabelsEqual(draft.labels, runner.labels)) patch.labels = [...draft.labels];
  if (draft.maxConcurrentSessions !== runner.maxConcurrentSessions) {
    patch.maxConcurrentSessions = draft.maxConcurrentSessions;
  }
  if (draft.diskWatermarkBytes !== runner.diskWatermarkBytes) {
    patch.diskWatermarkBytes = draft.diskWatermarkBytes;
  }
  if (draft.reserved !== runner.reserved) patch.reserved = draft.reserved;
  return patch;
};

/**
 * Returns the field that caused a `conflict` error for a patch, or `null` when
 * the error is not a conflict or the field cannot be known.
 *
 * The controller returns one `conflict` per patch and does not say which field
 * caused it, so the patch decides: a field the patch did not send cannot be
 * the cause. When a patch changes both `name` and `reserved`, there is no way
 * to tell which one caused the conflict, so it returns `null` rather than
 * blaming a field that may be fine.
 */
export const findRunnerConflictField = (
  error: unknown,
  patch: RunnerUpdateInput,
): "name" | "reserved" | null => {
  if (!(error instanceof ApiError) || error.code !== "conflict") return null;
  if (patch.name !== undefined && patch.reserved !== undefined) return null;
  if (patch.name !== undefined) return "name";
  if (patch.reserved !== undefined) return "reserved";
  return null;
};

/** The warnings to show before retiring a runner, and whether the retire must be forced. */
export interface RetireQuestion {
  /** Warnings shown before the user confirms, in addition to the question itself. */
  readonly warnings: ReadonlyArray<string>;
  /** Whether the controller rejects the retire unless it is forced. */
  readonly force: boolean;
}

const UNREACHABLE = "This runner is unreachable; retiring it now forces it.";

const LOSES_DEFAULT = "This is the default runner; the fleet will have no default.";

/**
 * Returns the warnings for retiring a runner. Retiring cannot be undone, and
 * the button does not show its two possible costs:
 *
 * - an unreachable runner may still be running sessions that nobody can
 *   follow any more, and the controller retires it only when forced;
 * - retiring the fleet's default runner leaves the fleet without one.
 */
export const buildRetireQuestion = (
  runner: Runner,
  defaultRunnerId: string | null,
): RetireQuestion => {
  const unreachable = runner.connectivity === "unreachable";
  const warnings: Array<string> = [];
  if (unreachable) warnings.push(UNREACHABLE);
  if (runner.id === defaultRunnerId) warnings.push(LOSES_DEFAULT);
  return { warnings, force: unreachable };
};
