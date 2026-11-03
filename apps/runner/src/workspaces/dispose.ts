/** Removes only recorded managed working files and preserves their source Git repositories. */
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join as joinPath, relative, resolve } from "node:path";
import {
  MAX_CHECKOUTS,
  MAX_MESSAGE_LENGTH,
  type WorkspaceDetach,
  type WorkspaceDispose,
  type WorkspaceRemoval,
  type WorkspaceReport,
} from "@hercule/protocol";
import * as Effect from "effect/Effect";
import { deleteArchivedSessionFiles } from "./archived-session-files";
import { observeCheckoutsAfterFailedRemoval, planCheckoutRemovals } from "./checkout-removal";
import { isInsideDirectory, normalizeError, validateManagedPath } from "./managed-paths";
import type { Removal, RegisteredCheckout, RegisteredWorkspace } from "./registry";
import { isRootBoundary, removeRootBoundary } from "./root-boundary";
import type { Substrate } from "./substrate";

/**
 * Checks whether two requests carry the same removal intent and correlation
 * identifier. The `archivedSessions` list is not part of the intent: it only
 * adds cleanup of harness files, so a request resent with the list, after an
 * older runner removed the workspace without it, is still the same request.
 */
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
          // The empty boundary file the runner made at the root is not a file to preserve.
          if (directory === root && name === ".git" && isRootBoundary(root)) continue;
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

const removeEmptyDirectories = (root: string): void => {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const child = joinPath(root, name);
    if (lstatSync(child).isDirectory()) removeEmptyDirectories(child);
  }
  rmdirSync(root);
};

/**
 * Removes a managed workspace: first each of its checkouts, then the folder
 * with whatever is still in it. Unless changes are discarded, nothing is
 * removed before every checkout and every root file passes preflight.
 * Returns a warning for each checkout whose Git repository cannot be found,
 * which only happens when changes are discarded.
 */
const removeManagedWorkspace = (
  substrate: Substrate,
  entry: RegisteredWorkspace,
  discardChanges: boolean,
): Effect.Effect<ReadonlyArray<string>, Error> =>
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
    }
    const checkouts = yield* planCheckoutRemovals(substrate, entry, canonicalRoot, discardChanges);
    const removed: Array<string> = [];
    yield* checkouts.coordinate(
      Effect.gen(function* () {
        yield* checkouts.preflight;
        const remaining = yield* findRemainingRootFiles(entry.root, entry.checkouts);
        if (!discardChanges && remaining.length > 0)
          return yield* Effect.fail(
            new Error(
              `Workspace root files remain outside its checkouts: ${remaining.join(", ")}. Preserve those files or explicitly choose discard changes.`,
            ),
          );
        yield* Effect.gen(function* () {
          yield* checkouts.removeAll((path) => removed.push(path));
          yield* validateManagedPath(substrate, entry.root);
          yield* Effect.try({
            try: () => {
              if (discardChanges) rmSync(entry.root, { recursive: true, force: true });
              else {
                removeRootBoundary(entry.root);
                removeEmptyDirectories(entry.root);
              }
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
      }),
    );
    return checkouts.warnings;
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
    let checkoutWarnings: ReadonlyArray<string> = [];
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
        checkoutWarnings = yield* removeManagedWorkspace(
          substrate,
          entry,
          instruction.discardChanges === true,
        );
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
      const fileWarnings =
        instruction._tag === "workspaceDispose" && instruction.archivedSessions !== undefined
          ? yield* deleteArchivedSessionFiles(
              substrate.deleteSessionFiles,
              instruction.archivedSessions,
            )
          : [];
      const warnings = [...fileWarnings, ...checkoutWarnings]
        .slice(0, MAX_CHECKOUTS)
        .map((warning) => warning.slice(0, MAX_MESSAGE_LENGTH));
      return {
        _tag: "workspaceReport",
        workspaceId,
        status: "deleted",
        ...(requestId === undefined ? {} : { requestId }),
        ...(warnings.length === 0 ? {} : { warnings }),
      } satisfies WorkspaceReport;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          return {
            ...(yield* observeCheckoutsAfterFailedRemoval(substrate, entry)),
            _tag: "workspaceReport",
            workspaceId,
            status: "failed",
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
