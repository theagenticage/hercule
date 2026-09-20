/**
 * `workspaces.json`: where this machine's workspaces are on its disk.
 *
 * The controller stores no path, so this file is the only record of where a
 * workspace lives; a daemon that lost it would strand the user's work. It is
 * read afresh on every use rather than cached, so a restart needs no warm-up
 * and two readers never disagree, and it is decoded rather than cast: an entry
 * a hand-edit or an older build made unreadable is dropped, and the rest of the
 * machine's workspaces still stand.
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

/** One working copy, as the machine holds it. */
export type RegisteredCheckout = Schema.Schema.Type<typeof RegisteredCheckout>;

const RegisteredWorkspace = Schema.Struct({
  workspaceId: StorageId,
  kind: WorkspaceKind,
  /** The directory the workspace is; a primary's is the checkout's own folder. */
  root: Schema.String,
  checkouts: Schema.Array(RegisteredCheckout),
});

export type RegisteredWorkspace = Schema.Schema.Type<typeof RegisteredWorkspace>;

const decodeEntry = Schema.decodeUnknownResult(RegisteredWorkspace);

/**
 * Whether the directories this entry names are still there. A workspace
 * somebody removed underneath the machine is one no session can be placed in
 * and one nothing can be re-reported about, so both readers ask it here rather
 * than each keeping its own idea of what standing means.
 */
export const stillOnDisk = (entry: RegisteredWorkspace): boolean =>
  existsSync(entry.root) && entry.checkouts.every((one) => existsSync(one.path));

const registryPathIn = (storageDir: string): string => joinPath(storageDir, "workspaces.json");

/**
 * A file that is not there yet, or that something outside Hydra has made
 * unreadable, is read as an empty registry: a machine that holds nothing is
 * exactly what the controller then re-provisions against.
 */
const readRegistry = (storageDir: string): ReadonlyArray<RegisteredWorkspace> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPathIn(storageDir), "utf8"));
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
 * Written to a fresh file and renamed over the target, the way `runner.json` is:
 * a half-written registry would lose every workspace on the machine at once.
 */
const writeRegistry = (storageDir: string, entries: ReadonlyArray<RegisteredWorkspace>): void => {
  const path = registryPathIn(storageDir);
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
  /** The primary of a resource this machine holds, which `.workspaceinclude` is read from. */
  readonly primaryOf: (resourceId: string) => RegisteredWorkspace | undefined;
  readonly update: (
    change: (entries: ReadonlyArray<RegisteredWorkspace>) => ReadonlyArray<RegisteredWorkspace>,
  ) => Promise<void>;
}

export const makeRegistry = (storageDir: string): Registry => {
  /**
   * Read, change, write, one caller at a time: two workspaces being provisioned
   * at once would otherwise each write the registry they read before the other.
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
