/** Removes only recorded managed working files and preserves their source Git repositories. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join as joinPath, relative, resolve, sep } from "node:path";
import {
  MAX_MESSAGE_LENGTH,
  type WorkspaceDetach,
  type WorkspaceDispose,
  type WorkspaceRemoval,
  type WorkspaceReport,
} from "@hercule/protocol";
import * as Effect from "effect/Effect";
import { buildCacheDir, removeWorktree, runGit } from "./git";
import { hasExpectedCheckoutIdentity } from "./identity";
import { observeWorkspace } from "./inspection";
import {
  isStillOnDisk,
  type RegisteredCheckout,
  type RegisteredWorkspace,
  type Removal,
} from "./registry";
import type { Substrate } from "./substrate";

/** Checks whether two requests carry the same removal intent and correlation identifier. */
export const hasSameRemovalIntent = (first: WorkspaceRemoval, second: WorkspaceRemoval): boolean =>
  first._tag === second._tag &&
  first.workspaceId === second.workspaceId &&
  first.requestId === second.requestId &&
  (first._tag !== "workspaceDispose" ||
    second._tag !== "workspaceDispose" ||
    (first.discardChanges ?? false) === (second.discardChanges ?? false));

/** Returns the directory that holds one directory of step result files per workspace. */
export const buildStepResultsRoot = (storageDir: string): string =>
  joinPath(storageDir, "step-results");

/** Returns the runner-owned result directory outside a workspace's working files. */
export const buildStepResultsDir = (storageDir: string, workspaceId: string): string =>
  joinPath(buildStepResultsRoot(storageDir), workspaceId);

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const isInsideDirectory = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
};

/** Checks that a recorded managed path still names the runner's original storage location. */
const validateManagedPath = (substrate: Substrate, path: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const storage = realpathSync(substrate.storageDir);
      const expected = resolve(storage, relative(resolve(substrate.storageDir), resolve(path)));
      if (!isInsideDirectory(storage, expected))
        throw new Error(
          "The recorded workspace path is outside managed storage. Preserve its files and restore its registry.",
        );
      let ancestor = resolve(path);
      while (ancestor !== resolve(substrate.storageDir)) {
        try {
          const physical = lstatSync(ancestor);
          const expectedAncestor = resolve(
            storage,
            relative(resolve(substrate.storageDir), ancestor),
          );
          if (physical.isSymbolicLink() || realpathSync(ancestor) !== expectedAncestor)
            throw new Error(
              "The recorded managed directory or one of its parent directories was replaced or redirected. Preserve its files and restore the original workspace.",
            );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          ancestor = dirname(ancestor);
        }
      }
    },
    catch: normalizeError,
  });

/** Finds files outside recorded checkout boundaries, including nested paths and ignored root files. */
const findRemainingRootFiles = (
  root: string,
  checkouts: ReadonlyArray<RegisteredCheckout>,
): Effect.Effect<ReadonlyArray<string>, Error> =>
  Effect.try({
    try: () => {
      if (
        !existsSync(root) ||
        checkouts.some((checkout) => resolve(checkout.path) === resolve(root))
      )
        return [];
      const paths = checkouts.map((checkout) => resolve(checkout.path));
      const remaining: Array<string> = [];
      const visit = (directory: string): void => {
        for (const name of readdirSync(directory)) {
          const path = joinPath(directory, name);
          if (paths.includes(resolve(path))) continue;
          if (
            lstatSync(path).isDirectory() &&
            paths.some((checkout) => isInsideDirectory(resolve(path), checkout))
          )
            visit(path);
          else remaining.push(relative(root, path));
        }
      };
      visit(root);
      return remaining;
    },
    catch: normalizeError,
  });

const checkWorkingFiles = (
  substrate: Substrate,
  checkout: RegisteredCheckout,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!existsSync(checkout.path)) return;
    const status = yield* runGit(
      [
        "-C",
        checkout.path,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      { env: { ...substrate.gitEnv, GIT_OPTIONAL_LOCKS: "0" } },
    );
    if (!status.ok)
      return yield* Effect.fail(
        new Error(
          `Cannot inspect remaining checkout files. Restore its Git repository before disposal: ${status.stderr}`,
        ),
      );
    if (status.stdout.length > 0)
      return yield* Effect.fail(
        new Error(
          "Tracked changes, untracked files or ignored files remain. Preserve those files or explicitly choose discard changes.",
        ),
      );
  });

const removeEmptyDirectories = (root: string): void => {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const child = joinPath(root, name);
    if (lstatSync(child).isDirectory()) removeEmptyDirectories(child);
  }
  rmdirSync(root);
};

/** Removes clean worktrees only after every checkout and root file passes preflight. */
const removeManagedWorkspace = (
  substrate: Substrate,
  entry: RegisteredWorkspace,
  discardChanges: boolean,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const parent = resolve(
      substrate.storageDir,
      entry.kind === "primary" ? "primaries" : "workspaces",
    );
    const expectedRoot = resolve(parent, entry.workspaceId);
    if (dirname(expectedRoot) !== parent || resolve(entry.root) !== expectedRoot)
      return yield* Effect.fail(
        new Error(
          "The recorded root does not belong to this managed workspace. Preserve its files and restore the workspace registry before disposal.",
        ),
      );
    yield* validateManagedPath(substrate, entry.root);
    const canonicalRoot = resolve(
      yield* Effect.try({ try: () => realpathSync(substrate.storageDir), catch: normalizeError }),
      relative(resolve(substrate.storageDir), resolve(entry.root)),
    );
    const sources = new Map<string, string>();
    for (const checkout of entry.checkouts) {
      yield* validateManagedPath(substrate, checkout.path);
      if (
        resolve(checkout.path) !== resolve(entry.root) &&
        !isInsideDirectory(resolve(entry.root), resolve(checkout.path))
      )
        return yield* Effect.fail(
          new Error(
            "A recorded checkout lies outside its managed workspace root. Restore the registry before disposal.",
          ),
        );
      let common = checkout.commonDirectory;
      if (common === undefined && existsSync(checkout.path)) {
        const found = yield* runGit(
          ["-C", checkout.path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { env: substrate.gitEnv },
        );
        if (!found.ok)
          return yield* Effect.fail(
            new Error(
              "The recorded checkout Git repository is unavailable. Restore it before disposal.",
            ),
          );
        common = found.stdout;
      }
      common ??= buildCacheDir(substrate.storageDir, checkout.resourceId);
      const source = common;
      const canonical = yield* Effect.try({
        try: () => realpathSync(source),
        catch: normalizeError,
      });
      if (
        canonical ===
          (yield* Effect.try({
            try: () => realpathSync(substrate.storageDir),
            catch: normalizeError,
          })) ||
        canonical === canonicalRoot ||
        isInsideDirectory(canonicalRoot, canonical)
      )
        return yield* Effect.fail(
          new Error(
            "This workspace contains its source Git repository. Preserve the standalone main repository; it cannot be discarded.",
          ),
        );
      sources.set(checkout.checkoutId, canonical);
    }
    const keys = [...new Set(sources.values())].sort();
    const removed: Array<string> = [];
    const remove = Effect.gen(function* () {
      for (const checkout of entry.checkouts) {
        const common = sources.get(checkout.checkoutId)!;
        const physical = yield* Effect.try({ try: () => statSync(common), catch: normalizeError });
        if (
          checkout.commonDirectoryIdentity !== undefined &&
          checkout.commonDirectoryIdentity !== `${String(physical.dev)}:${String(physical.ino)}`
        )
          return yield* Effect.fail(
            new Error(
              "The recorded source Git repository was replaced. Restore the original repository before disposal.",
            ),
          );
        if (
          existsSync(checkout.path) &&
          !hasExpectedCheckoutIdentity(
            { ...entry, root: checkout.path, checkouts: [checkout] },
            substrate.gitEnv,
          )
        )
          return yield* Effect.fail(
            new Error(
              "The recorded checkout Git binding changed. Preserve its files and restore the original repository before disposal.",
            ),
          );
        if (!discardChanges) yield* checkWorkingFiles(substrate, checkout);
      }
      const remaining = yield* findRemainingRootFiles(entry.root, entry.checkouts);
      if (!discardChanges && remaining.length > 0)
        return yield* Effect.fail(
          new Error(
            `Workspace root files remain outside its checkouts: ${remaining.join(", ")}. Preserve those files or explicitly choose discard changes.`,
          ),
        );
      yield* Effect.gen(function* () {
        for (const checkout of entry.checkouts) {
          const common = sources.get(checkout.checkoutId)!;
          const listed = yield* runGit(["-C", common, "worktree", "list", "--porcelain", "-z"], {
            env: substrate.gitEnv,
          });
          if (!listed.ok)
            return yield* Effect.fail(
              new Error(`Cannot inspect the recorded worktree registration: ${listed.stderr}`),
            );
          const canonicalCheckoutRoot =
            checkout.canonicalRoot ??
            (yield* Effect.try({
              try: () =>
                resolve(
                  realpathSync(substrate.storageDir),
                  relative(resolve(substrate.storageDir), resolve(checkout.path)),
                ),
              catch: normalizeError,
            }));
          const registered = listed.stdout
            .split("\0")
            .includes(`worktree ${canonicalCheckoutRoot}`);
          if (existsSync(checkout.path) || registered) {
            yield* validateManagedPath(substrate, checkout.path);
            if (
              existsSync(checkout.path) &&
              !hasExpectedCheckoutIdentity(
                { ...entry, root: checkout.path, checkouts: [checkout] },
                substrate.gitEnv,
              )
            )
              return yield* Effect.fail(
                new Error(
                  "The checkout changed after preflight. Preserve the remaining files and restore its original Git binding.",
                ),
              );
            if (!discardChanges) yield* checkWorkingFiles(substrate, checkout);
            const result = yield* removeWorktree(
              sources.get(checkout.checkoutId)!,
              checkout.path,
              substrate.gitEnv,
              discardChanges,
            );
            if (!result.ok)
              return yield* Effect.fail(
                new Error(
                  `Git refused to remove the checkout: ${result.stderr}. Preserve its files before retrying disposal.`,
                ),
              );
            removed.push(checkout.path);
          }
        }
        yield* validateManagedPath(substrate, entry.root);
        yield* Effect.try({
          try: () => {
            if (discardChanges) rmSync(entry.root, { recursive: true, force: true });
            else removeEmptyDirectories(entry.root);
          },
          catch: normalizeError,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (removed.length > 0)
              return yield* Effect.fail(
                new Error(
                  `Removal was partial; these checkouts were removed: ${removed.join(", ")}. Remaining files were preserved. ${error.message}`,
                  { cause: error },
                ),
              );
            return yield* Effect.fail(error);
          }),
        ),
      );
    });
    const lock = (at: number): Effect.Effect<void, Error> =>
      at === keys.length
        ? remove
        : substrate.coordinateRepository(`git:${keys[at]!}`, lock(at + 1));
    yield* lock(0);
  });

/** Records and executes disposal or detachment, replaying completed receipts without deleting new files. */
const removeWorkspace = (
  substrate: Substrate,
  instruction: WorkspaceRemoval,
): Effect.Effect<WorkspaceReport, Error> =>
  Effect.gen(function* () {
    const { workspaceId, requestId } = instruction;
    const recorded = yield* substrate.registry.readRemoval(workspaceId);
    const sameInstruction =
      recorded !== undefined && hasSameRemovalIntent(recorded.instruction, instruction);
    if (
      recorded !== undefined &&
      requestId !== undefined &&
      recorded.instruction.requestId === requestId &&
      !sameInstruction
    )
      return yield* Effect.fail(
        new Error(
          "This request ID already identifies a different removal instruction. Preserve the frozen intent and use a fresh request ID only after its outcome.",
        ),
      );
    if (recorded?.phase === "pending" && !sameInstruction)
      return yield* Effect.fail(
        new Error(
          "A different removal request is pending for this workspace. Retry its original request before changing the removal intent.",
        ),
      );
    if (
      recorded?.phase === "terminal" &&
      recorded.report !== undefined &&
      (recorded.report.status === "deleted" || (sameInstruction && requestId !== undefined))
    ) {
      if (
        recorded.report.status === "deleted" &&
        recorded.instruction._tag === "workspaceDispose" &&
        (recorded.workspace === undefined
          ? [
              joinPath(substrate.storageDir, "workspaces", workspaceId),
              joinPath(substrate.storageDir, "primaries", workspaceId),
            ].some((path) => existsSync(path))
          : existsSync(recorded.workspace.root))
      )
        return yield* Effect.fail(
          new Error(
            "The disposed workspace path has reappeared. Its new files are not authorized by the old removal receipt; preserve them and recover the registry.",
          ),
        );
      return { ...recorded.report, ...(requestId === undefined ? {} : { requestId }) };
    }
    const entry =
      recorded?.phase === "pending"
        ? recorded.workspace
        : (yield* substrate.registry.all()).find(
            (workspace) => workspace.workspaceId === workspaceId,
          );
    if (entry !== undefined && entry.workspaceId !== workspaceId)
      return yield* Effect.fail(
        new Error(
          "The recorded removal snapshot belongs to a different workspace. Preserve its files and restore the removal record before retrying.",
        ),
      );
    const pending: Removal = {
      workspaceId,
      instruction,
      phase: "pending",
      ...(entry === undefined ? {} : { workspace: entry }),
    };
    yield* substrate.registry.recordRemoval(pending);
    const report = yield* Effect.gen(function* () {
      if (instruction._tag === "workspaceDetach") {
        if (entry !== undefined && (entry.ownership !== "adopted" || entry.kind !== "primary"))
          return yield* Effect.fail(
            new Error(
              "Only an attached main workspace can be detached. Use dispose for managed working files.",
            ),
          );
      } else if (entry === undefined) {
        const candidates = [
          joinPath(substrate.storageDir, "workspaces", workspaceId),
          joinPath(substrate.storageDir, "primaries", workspaceId),
        ];
        if (candidates.some((path) => existsSync(path)))
          return yield* Effect.fail(
            new Error(
              "Workspace files remain without a registry ownership record. Preserve them and restore the registry before disposal.",
            ),
          );
      } else {
        if (entry.ownership === "adopted")
          return yield* Effect.fail(
            new Error(
              "This is an attached, user-owned checkout. Use detach to forget its registration without deleting files.",
            ),
          );
        if (entry.kind === "primary" && instruction.discardChanges !== true)
          return yield* Effect.fail(
            new Error(
              "A managed main workspace requires an explicit discard changes choice before disposal.",
            ),
          );
        const resultsRoot = buildStepResultsRoot(substrate.storageDir);
        const resultsDirectory = buildStepResultsDir(substrate.storageDir, workspaceId);
        yield* validateManagedPath(substrate, resultsRoot);
        yield* validateManagedPath(substrate, resultsDirectory);
        yield* removeManagedWorkspace(substrate, entry, instruction.discardChanges === true);
        yield* Effect.gen(function* () {
          yield* validateManagedPath(substrate, resultsRoot);
          yield* validateManagedPath(substrate, resultsDirectory);
          yield* Effect.try({
            try: () => rmSync(resultsDirectory, { recursive: true, force: true }),
            catch: normalizeError,
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.fail(
              new Error(
                `The working files were removed, but step result cleanup was refused: ${error.message}`,
                { cause: error },
              ),
            ),
          ),
        );
      }
      return {
        _tag: "workspaceReport",
        workspaceId,
        status: "deleted",
        ...(requestId === undefined ? {} : { requestId }),
      } satisfies WorkspaceReport;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const observation =
            entry === undefined ? {} : yield* observeWorkspace(entry, substrate.gitEnv);
          return {
            ...observation,
            _tag: "workspaceReport",
            workspaceId,
            status: "failed",
            available:
              entry !== undefined &&
              isStillOnDisk(entry) &&
              hasExpectedCheckoutIdentity(entry, substrate.gitEnv),
            ...(requestId === undefined ? {} : { requestId }),
            message: error.message.slice(0, MAX_MESSAGE_LENGTH),
          } satisfies WorkspaceReport;
        }),
      ),
    );
    yield* substrate.registry.recordRemoval({ ...pending, phase: "terminal", report });
    return report;
  });

export const disposeWorkspace = (
  substrate: Substrate,
  frame: WorkspaceDispose,
): Effect.Effect<WorkspaceReport, Error> => removeWorkspace(substrate, frame);
export const detachWorkspace = (
  substrate: Substrate,
  frame: WorkspaceDetach,
): Effect.Effect<WorkspaceReport, Error> => removeWorkspace(substrate, frame);
