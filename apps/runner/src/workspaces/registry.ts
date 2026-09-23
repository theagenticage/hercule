/**
 * `workspaces.json`: the record of where this runner's workspaces are on disk.
 *
 * The controller stores no paths, so this file is the only record of where a
 * workspace lives. A runner that lost it would strand the user's work. The
 * file is read again on every use instead of being cached, so a restart needs
 * no warm-up and two readers never disagree. Each entry is decoded with a
 * schema, not cast: an entry that a hand edit or an older build made
 * unreadable is dropped, and the runner's other workspaces are kept.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { StorageId, WorkspaceKind } from "@hercule/protocol";

const RegisteredCheckout = Schema.Struct({
  checkoutId: StorageId,
  resourceId: StorageId,
  remote: Schema.String,
  path: Schema.String,
});

/** One checkout, as the registry records it. */
export type RegisteredCheckout = Schema.Schema.Type<typeof RegisteredCheckout>;

const RegisteredWorkspace = Schema.Struct({
  workspaceId: StorageId,
  kind: WorkspaceKind,
  /** The workspace's directory. For a primary this is the checkout's own directory. */
  root: Schema.String,
  checkouts: Schema.Array(RegisteredCheckout),
});

export type RegisteredWorkspace = Schema.Schema.Type<typeof RegisteredWorkspace>;

const decodeEntry = Schema.decodeUnknownResult(RegisteredWorkspace);

/**
 * Checks that the workspace root and every checkout directory in the entry
 * still exist. A workspace whose directory was removed cannot have a session
 * placed in it, and cannot be reported as ready. Every caller uses this one
 * check, so they all agree on what counts as still there.
 */
export const isStillOnDisk = (entry: RegisteredWorkspace): boolean =>
  existsSync(entry.root) && entry.checkouts.every((one) => existsSync(one.path));

const buildRegistryPath = (storageDir: string): string => joinPath(storageDir, "workspaces.json");

/**
 * Reads the registry and returns its valid entries. A missing file, or one that
 * something outside Hercule made unreadable, reads as an empty registry. A
 * runner with no workspaces is a state the controller already handles: it
 * provisions the workspaces again.
 */
const readRegistry = (storageDir: string): ReadonlyArray<RegisteredWorkspace> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(buildRegistryPath(storageDir), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => decodeEntry(entry))
    .filter((decoded) => Result.isSuccess(decoded))
    .map((decoded) => decoded.success);
};

/**
 * Writes the registry to a new temporary file and renames it over the old one,
 * the same way `runner.json` is written. A half-written registry would lose
 * every workspace on the runner at once.
 */
const writeRegistry = (storageDir: string, entries: ReadonlyArray<RegisteredWorkspace>): void => {
  const path = buildRegistryPath(storageDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

export interface Registry {
  readonly all: () => ReadonlyArray<RegisteredWorkspace>;
  readonly held: (workspaceId: string) => RegisteredWorkspace | undefined;
  /**
   * Returns this runner's primary for a resource, or undefined if it has none.
   * `.workspaceinclude` and the files it lists are read from the primary.
   */
  readonly primaryOf: (resourceId: string) => RegisteredWorkspace | undefined;
  readonly update: (
    change: (entries: ReadonlyArray<RegisteredWorkspace>) => ReadonlyArray<RegisteredWorkspace>,
  ) => Promise<void>;
}

export const makeRegistry = (storageDir: string): Registry => {
  /**
   * Runs updates one at a time, so each read, change and write finishes before
   * the next starts. Otherwise two workspaces provisioned at once could each
   * write back the registry they had read, and one change would be lost.
   */
  let pending: Promise<void> = Promise.resolve();
  return {
    all: () => readRegistry(storageDir),
    held: (workspaceId) =>
      readRegistry(storageDir).find((entry) => entry.workspaceId === workspaceId),
    primaryOf: (resourceId) =>
      readRegistry(storageDir).find(
        (entry) =>
          entry.kind === "primary" && entry.checkouts.some((one) => one.resourceId === resourceId),
      ),
    update: (change) => {
      const done = pending.then(() => {
        writeRegistry(storageDir, change(readRegistry(storageDir)));
      });
      // Even a failed write leaves the queue usable for the next caller.
      pending = done.catch(() => undefined);
      return done;
    },
  };
};
