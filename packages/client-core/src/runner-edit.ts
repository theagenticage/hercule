/**
 * Editing and retiring one runner: what a form draft means, where a refusal
 * belongs, and what has to be said before a machine is retired. All three are
 * readings of the domain, so they live here with a test rather than in a
 * component.
 */
import type { Runner, RunnerUpdateInput } from "@hydra/contract";
import { ApiError } from "./errors";

/** The five fields a runner's owner writes, as a form holds them. */
export interface RunnerDraft {
  readonly name: string;
  readonly labels: ReadonlyArray<string>;
  readonly maxConcurrentSessions: number;
  readonly diskWatermarkBytes: number;
  readonly reserved: boolean;
}

/** The draft a form opens on. */
export const runnerDraft = (runner: Runner): RunnerDraft => ({
  name: runner.name,
  labels: runner.labels,
  maxConcurrentSessions: runner.maxConcurrentSessions,
  diskWatermarkBytes: runner.diskWatermarkBytes,
  reserved: runner.reserved,
});

/** Labels are replaced whole, so their order is part of the value. */
const sameLabels = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);

/**
 * What a draft asks the controller to change, and nothing else.
 *
 * A patch naming a field the runner already holds is a write like any other: it
 * stamps an actor and appends an audit row. Sending only what moved keeps the
 * trail readable, and an empty patch is what the form reads as an untouched one.
 *
 * The name is trimmed here and nowhere else, so padding a name is not a change
 * while a name the user has emptied still reads as one. The form refuses to
 * submit that, and a draft that differs from the machine is what stops a fresh
 * answer refilling the field under the user.
 */
export const runnerPatch = (runner: Runner, draft: RunnerDraft): RunnerUpdateInput => {
  const patch: { -readonly [K in keyof RunnerUpdateInput]: RunnerUpdateInput[K] } = {};
  const name = draft.name.trim();
  if (name !== runner.name) patch.name = name;
  if (!sameLabels(draft.labels, runner.labels)) patch.labels = [...draft.labels];
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
 * Which field a refused patch was refused over.
 *
 * The controller answers one `conflict` per patch and names no field, so the
 * patch itself is what attributes it: a name it did not send cannot be the name
 * that was taken. A patch moving both fields at once leaves no way to tell them
 * apart, and the refusal is answered whole rather than pinned on a field that
 * may be innocent.
 */
export const runnerConflictField = (
  error: unknown,
  patch: RunnerUpdateInput,
): "name" | "reserved" | null => {
  if (!(error instanceof ApiError) || error.code !== "conflict") return null;
  if (patch.name !== undefined && patch.reserved !== undefined) return null;
  if (patch.name !== undefined) return "name";
  if (patch.reserved !== undefined) return "reserved";
  return null;
};

/** What retiring this runner costs, and whether it has to be forced. */
export interface RetireQuestion {
  /** What the user is told before confirming, beyond the question itself. */
  readonly warnings: ReadonlyArray<string>;
  /** Whether the controller will refuse without being told to do it anyway. */
  readonly force: boolean;
}

const UNREACHABLE = "This runner is unreachable; retiring it now forces it.";

const LOSES_DEFAULT = "This is the default runner; the fleet will have no default.";

/**
 * Retiring is not undoable and the two things it costs are not on the button.
 * A machine the controller cannot reach may still be running sessions nobody
 * can see the end of, and retiring the fleet's default leaves it without one.
 */
export const retireQuestion = (runner: Runner, defaultRunnerId: string | null): RetireQuestion => {
  const unreachable = runner.connectivity === "unreachable";
  const warnings: Array<string> = [];
  if (unreachable) warnings.push(UNREACHABLE);
  if (runner.id === defaultRunnerId) warnings.push(LOSES_DEFAULT);
  return { warnings, force: unreachable };
};
