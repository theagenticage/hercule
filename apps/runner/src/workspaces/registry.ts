/**
 * Records runner-local workspace paths and durable preparation outcomes.
 * Legacy entries retain their paths without repeating setup. Invalid registry
 * state requires recovery rather than permitting recreation of existing files.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { StorageId, WorkspaceKind, WorkspaceProvision, WorkspaceReport } from "@hercule/protocol";

const RegisteredCheckout = Schema.Struct({
  checkoutId: StorageId,
  resourceId: StorageId,
  remote: Schema.String,
  path: Schema.String,
});

/** One checkout, as the registry records it. */
export type RegisteredCheckout = Schema.Schema.Type<typeof RegisteredCheckout>;

const Preparation = Schema.Union([
  Schema.Struct({
    phase: Schema.Literals(["creating", "preparing"]),
    instruction: WorkspaceProvision,
  }),
  Schema.Struct({
    phase: Schema.Literal("terminal"),
    instruction: WorkspaceProvision,
    report: WorkspaceReport,
  }),
]);

const RegisteredWorkspace = Schema.Struct({
  workspaceId: StorageId,
  kind: WorkspaceKind,
  /** The workspace's directory. For a primary this is the checkout's own directory. */
  root: Schema.String,
  checkouts: Schema.Array(RegisteredCheckout),
  preparation: Schema.optionalKey(Preparation),
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
 * Reads valid registry entries. Only a missing file represents an empty
 * registry. Fails on unreadable content so no existing files can be recreated
 * from an incomplete account of the runner's workspaces.
 */
const readRegistry = (storageDir: string): ReadonlyArray<RegisteredWorkspace> => {
  let content: string;
  try {
    content = readFileSync(buildRegistryPath(storageDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      "Cannot read the workspace registry. Restore its readable contents before provisioning.",
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      "The workspace registry is invalid. Restore a valid registry before provisioning.",
      { cause: error },
    );
  }
  if (!Array.isArray(parsed))
    throw new Error(
      "The workspace registry must be a list. Restore a valid registry before provisioning.",
    );
  return parsed.map((entry) => {
    const decoded = decodeEntry(entry);
    if (Result.isFailure(decoded))
      throw new Error(
        "The workspace registry contains an invalid entry. Restore a valid registry before provisioning.",
        { cause: decoded.failure },
      );
    return decoded.success;
  });
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
          entry.kind === "primary" &&
          (entry.preparation === undefined ||
            (entry.preparation.phase === "terminal" &&
              entry.preparation.report.status === "ready")) &&
          isStillOnDisk(entry) &&
          entry.checkouts.some((one) => one.resourceId === resourceId),
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
