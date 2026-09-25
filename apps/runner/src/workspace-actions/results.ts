/**
 * The result file of each finished workspace step: how the step ended, kept
 * on disk so a start the controller sends again is answered with the same
 * result instead of running the action twice.
 *
 * The files live at `<storage>/step-results/<workspaceId>/<step>.json`,
 * outside every checkout, so a commit can never pick one up. They are deleted:
 *
 * - all at once, when their workspace is disposed;
 * - one by one, when a stop for the step arrives, because the controller no
 *   longer owes a step it stops.
 *
 * A primary is never disposed, and the runner cannot tell when the controller
 * has read a result it sent: a result can be lost with the connection, and the
 * controller then asks again on reconnect. So a primary's file stays until a
 * stop for its step arrives. Each file is a few hundred bytes.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { WorkspaceStepOutcome, type WorkspaceStepKey } from "@hercule/protocol";
import { buildStepResultsDir, buildStepResultsRoot } from "../workspaces";

const decodeOutcome = Schema.decodeUnknownResult(WorkspaceStepOutcome);
const encodeOutcome = Schema.encodeSync(WorkspaceStepOutcome);

/**
 * Returns the step key as one name, `<runId>-<stepId>-<iteration>`. Run ids
 * are UUIDs, which all have the same length, so two different keys never give
 * the same name.
 */
export const buildStepName = (key: WorkspaceStepKey): string =>
  `${key.runId}-${key.stepId}-${String(key.iteration)}`;

const buildResultPath = (storageDir: string, workspaceId: string, key: WorkspaceStepKey): string =>
  joinPath(buildStepResultsDir(storageDir, workspaceId), `${buildStepName(key)}.json`);

/**
 * Returns how the step ended, or undefined when it has no readable result
 * file. An unreadable file counts as none: the step then runs again, which is
 * what happens after a crash before the file was written.
 */
export const readStepResult = (
  storageDir: string,
  workspaceId: string,
  key: WorkspaceStepKey,
): WorkspaceStepOutcome | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(buildResultPath(storageDir, workspaceId, key), "utf8"));
  } catch {
    return undefined;
  }
  const decoded = decodeOutcome(parsed);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/**
 * Writes the step's result file. It is written to a temporary file and renamed
 * into place, so a crash never leaves half a result behind to be read as a
 * whole one.
 */
export const writeStepResult = (
  storageDir: string,
  workspaceId: string,
  key: WorkspaceStepKey,
  outcome: WorkspaceStepOutcome,
): void => {
  const path = buildResultPath(storageDir, workspaceId, key);
  mkdirSync(buildStepResultsDir(storageDir, workspaceId), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(encodeOutcome(outcome)), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

/**
 * Deletes the step's result file, whichever workspace it is in. A stop names
 * only the step, not its workspace, so every workspace's directory is looked
 * in. Does nothing when there is no such file.
 */
export const deleteStepResult = (storageDir: string, key: WorkspaceStepKey): void => {
  let workspaceIds: ReadonlyArray<string>;
  try {
    workspaceIds = readdirSync(buildStepResultsRoot(storageDir));
  } catch {
    return;
  }
  for (const workspaceId of workspaceIds) {
    rmSync(buildResultPath(storageDir, workspaceId, key), { force: true });
  }
};
