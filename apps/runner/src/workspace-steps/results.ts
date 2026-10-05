/**
 * The result file of each finished workspace step: how the step ended, kept
 * on disk so a start the controller sends again is answered with the same
 * result. Action steps and agent steps share this store:
 *
 * - for an action step, the file makes sure the action never runs twice;
 * - for an agent step, the file keeps the result of a turn that ended while
 *   the result could not reach the controller.
 *
 * The files live at `<storage>/step-results/<workspaceId>/<step>.json`,
 * outside every checkout, so a commit can never pick one up. An agent step
 * whose session has no workspace keeps its file in
 * `<storage>/step-results/.no-workspace/` instead. That name contains a dot,
 * which a workspace id may not, so it can never be the directory of a real
 * workspace. The files are deleted:
 *
 * - all at once, when their workspace is disposed;
 * - one by one, when a settle for the step arrives. The controller settles
 *   a step once it no longer owes it: when it cancels the step, and also
 *   once it has recorded how the step ended, to say it will never ask for
 *   that result again.
 *
 * The runner cannot tell on its own when the controller has read a result it
 * sent: a result can be lost with the connection, and the controller then
 * asks again on reconnect. So a file stays until that settle arrives, or
 * until its workspace is disposed. The settle matters most for a primary,
 * which is never disposed, and for a step with no workspace, which nothing
 * else ever deletes.
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
 * The directory, under the step results root, of the steps that ran with no
 * workspace. A workspace id is a storage id, made only of letters, digits,
 * `-` and `_`, so a name with a dot never collides with one.
 */
const NO_WORKSPACE_DIR = ".no-workspace";

/**
 * Returns the step key as one name, `<runId>-<stepId>-<iteration>`. Run ids
 * are UUIDs, which all have the same length, so two different keys never give
 * the same name.
 */
export const buildStepName = (key: WorkspaceStepKey): string =>
  `${key.runId}-${key.stepId}-${String(key.iteration)}`;

/** Returns the directory of the step result files of one workspace, or of the steps with none. */
const buildResultsDir = (storageDir: string, workspaceId: string | null): string =>
  workspaceId === null
    ? joinPath(buildStepResultsRoot(storageDir), NO_WORKSPACE_DIR)
    : buildStepResultsDir(storageDir, workspaceId);

const buildResultPath = (
  storageDir: string,
  workspaceId: string | null,
  key: WorkspaceStepKey,
): string => joinPath(buildResultsDir(storageDir, workspaceId), `${buildStepName(key)}.json`);

/**
 * Returns how the step ended, or undefined when it has no readable result
 * file. An unreadable file counts as none: the step then runs again, which is
 * what happens after a crash before the file was written.
 */
export const readStepResult = (
  storageDir: string,
  workspaceId: string | null,
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
  workspaceId: string | null,
  key: WorkspaceStepKey,
  outcome: WorkspaceStepOutcome,
): void => {
  const path = buildResultPath(storageDir, workspaceId, key);
  mkdirSync(buildResultsDir(storageDir, workspaceId), { recursive: true, mode: 0o700 });
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
 * Deletes the step's result file, whichever workspace it is in. A settle names
 * only the step, not its workspace, so every directory under the root is
 * looked in, the one for steps with no workspace included. Does nothing when
 * there is no such file.
 */
export const deleteStepResult = (storageDir: string, key: WorkspaceStepKey): void => {
  const root = buildStepResultsRoot(storageDir);
  let directories: ReadonlyArray<string>;
  try {
    directories = readdirSync(root);
  } catch {
    return;
  }
  for (const directory of directories) {
    rmSync(joinPath(root, directory, `${buildStepName(key)}.json`), { force: true });
  }
};
