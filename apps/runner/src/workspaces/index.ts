/**
 * Workspaces on this runner, built on git: provisions a workspace when the
 * controller asks for one, finds its directory afterwards, and tears it down
 * (spec 03 sections 6.1-6.6).
 *
 * The controller sends workspace ids and the runner works out the paths. The
 * registry on this runner, not the controller, records where each workspace is.
 */
import { realpathSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_MESSAGE_LENGTH,
  type WorkspaceDispose,
  type WorkspaceDetach,
  type WorkspaceRemoval,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import { attachWorkspace, reserveManagedRepositories } from "./attachment";
import { hasExpectedCheckoutIdentity } from "./identity";
import { disposeWorkspace, detachWorkspace, hasSameRemovalIntent } from "./dispose";
import { observeWorkspace, provisionWorkspace, reprovision } from "./provision";
import {
  makeRegistry,
  isStillOnDisk,
  type RegisteredCheckout,
  type RegisteredWorkspace,
} from "./registry";
import { SETUP_DEADLINE_MS, buildSubstrateEnv, type Substrate } from "./substrate";

export { buildStepResultsDir, buildStepResultsRoot } from "./dispose";
export { switchBranch, type GitOutcome, type GitEnv } from "./git";
export { buildTailMessage, drainTail } from "./output";
export { buildSubstrateEnv } from "./substrate";

/** The directories a session placed in a workspace works with. */
export interface Resolved {
  readonly root: string;
  readonly cwd: string;
  readonly checkouts: ReadonlyArray<RegisteredCheckout>;
}

export interface Workspaces {
  /** Idempotent: a workspace this runner already has is reported again, not created again. */
  readonly provision: (frame: WorkspaceProvision) => Effect.Effect<WorkspaceReport>;
  /** Replays removal outcomes and refuses remaining files without recorded ownership. */
  readonly dispose: (frame: WorkspaceDispose) => Effect.Effect<WorkspaceReport>;
  /** Forgets an attached workspace registration without deleting working files. */
  readonly detach: (frame: WorkspaceDetach) => Effect.Effect<WorkspaceReport>;
  readonly resolve: (workspaceId: string) => Effect.Effect<Resolved | undefined>;
  /**
   * Waits until the provisioning of this workspace that is in progress, if
   * any, has finished. The controller sends a workspace step right after the
   * provisioning frame of its workspace, and the step must not look for the
   * workspace before the provisioning has created it. Never rejects.
   */
  readonly waitForProvisioning: (workspaceId: string) => Effect.Effect<void>;
  /**
   * Checks whether the latest provisioning of this workspace on this runner
   * failed. The recorded failure survives runner restarts and is forgotten only
   * when the workspace is disposed.
   */
  readonly hasFailedProvisioning: (workspaceId: string) => Effect.Effect<boolean>;
  /**
   * Reads current checkout facts, coalesced per workspace. Returns a failed
   * recovery report when this runner cannot read a valid workspace record.
   */
  readonly inspect: (workspaceId: string) => Effect.Effect<WorkspaceReport>;
  /** Reads checkout facts after a turn or exit; returns undefined for an unknown workspace. */
  readonly reportAfterSession: (
    workspaceId: string,
  ) => Effect.Effect<WorkspaceReport | undefined, Error>;
  /**
   * Runs `work` while holding the checkout and common Git directory locks.
   * Aliases of the same checkout share the locks. Independent repositories
   * run side by side. Wrap every Git command that writes to a checkout:
   * two git processes that write to one checkout at the same time collide on
   * its `index.lock`, and one of them fails. A primary workspace is shared by
   * every session and run that uses its repository on this runner, so a
   * session's branch switch and a workspace step can meet there.
   */
  readonly runExclusively: <A, E, R>(
    workspaceId: string,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Returns the directory a session in this workspace starts in. With one
 * repository that is the checkout itself. With none or several it is the
 * workspace root, the only directory from which every repository is in view.
 */
const chooseCwd = (entry: RegisteredWorkspace): string =>
  entry.checkouts.length === 1 ? entry.checkouts[0]!.path : entry.root;

export const makeWorkspaces = (options: {
  readonly storageDir: string;
  /** Extra variables for the runner's git and setup commands, added on top of the scrubbed environment. */
  readonly gitEnv?: Record<string, string>;
  /** How long a setup command may run. Defaults to `SETUP_DEADLINE_MS`; tests set a shorter one. */
  readonly setupDeadlineMs?: number;
}): Effect.Effect<Workspaces, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
    const withRepositoryLock = <A, E, R>(
      key: string,
      work: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const entry = locks.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(key, entry);
        entry.users += 1;
        return entry.lock
          .withPermits(1)(work)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.users -= 1;
                if (entry.users === 0) locks.delete(key);
              }),
            ),
          );
      });
    const coordinateRepository = withRepositoryLock;
    const substrate: Substrate = {
      storageDir: options.storageDir,
      registry: makeRegistry(options.storageDir),
      coordinateRepository,
      gitEnv: buildSubstrateEnv(process.env, options.gitEnv),
      setupDeadlineMs: options.setupDeadlineMs ?? SETUP_DEADLINE_MS,
    };

    /**
     * Coalesces duplicate delivery while preparation is active. A second request
     * must wait for the original result rather than treating its recorded
     * in-progress phase as an interrupted preparation.
     */
    const inFlight = new Map<
      string,
      {
        readonly instruction: WorkspaceProvision;
        readonly result: Deferred.Deferred<WorkspaceReport>;
      }
    >();
    const coordinateRepositorySelection = <A, E, R>(
      resourceIds: ReadonlyArray<string>,
      work: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      [...new Set(resourceIds)]
        .sort()
        .reduceRight((held, id) => withRepositoryLock(`selection:${id}`, held), work);

    // Workers belong to the daemon, so reconnecting a socket does not interrupt preparation.
    const startWorkspaceOperation = (
      result: Deferred.Deferred<WorkspaceReport>,
      work: Effect.Effect<WorkspaceReport>,
      cleanup: () => void,
    ) =>
      Effect.forkIn(
        Deferred.into(work.pipe(Effect.ensuring(Effect.sync(cleanup))), result),
        scope,
        { uninterruptible: false },
      );
    const failureReport = (
      workspaceId: string,
      error: Error,
      requestId?: string,
    ): WorkspaceReport => ({
      _tag: "workspaceReport",
      workspaceId,
      status: "failed",
      ...(requestId === undefined ? {} : { requestId }),
      message: error.message.slice(0, MAX_MESSAGE_LENGTH),
    });

    /**
     * Returns the registered workspace, or undefined if this runner does not have
     * it or its directories were removed from disk. A session cannot be placed in
     * a directory that no longer exists, so such a workspace counts as unknown.
     */
    const findStandingWorkspace = (
      workspaceId: string,
    ): Effect.Effect<RegisteredWorkspace | undefined> =>
      Effect.gen(function* () {
        if (removalsInFlight.has(workspaceId)) return undefined;
        const entry = yield* substrate.registry
          .held(workspaceId)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return entry !== undefined &&
          (entry.preparation === undefined ||
            (entry.preparation.phase === "terminal" &&
              entry.preparation.report.status === "ready")) &&
          isStillOnDisk(entry) &&
          hasExpectedCheckoutIdentity(entry, substrate.gitEnv)
          ? entry
          : undefined;
      });

    const observations = new Map<string, Deferred.Deferred<WorkspaceReport>>();
    const inspect = (workspaceId: string): Effect.Effect<WorkspaceReport> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const running = observations.get(workspaceId);
          if (running !== undefined) return yield* restore(Deferred.await(running));
          const result = Deferred.makeUnsafe<WorkspaceReport>();
          observations.set(workspaceId, result);
          const observation = Effect.gen(function* () {
            const entry = yield* substrate.registry.held(workspaceId);
            if (entry === undefined)
              return yield* Effect.fail(
                new Error(
                  "This runner has no record of the workspace. Restore its registry before continuing.",
                ),
              );
            let report = yield* observeWorkspace(entry, substrate.gitEnv);
            const source =
              entry.kind === "primary" && entry.ownership === "adopted"
                ? entry.checkouts[0]
                : undefined;
            if (source !== undefined) {
              const candidates = (yield* substrate.registry.all()).filter(
                (workspace) =>
                  workspace.workspaceId !== workspaceId && workspace.ownership !== "adopted",
              );
              const unknown = candidates.some((workspace) =>
                workspace.checkouts.some(
                  (checkout) =>
                    checkout.resourceId === source.resourceId &&
                    checkout.commonDirectoryIdentity === undefined,
                ),
              );
              const derivedWorkspaceIds =
                source.commonDirectory === undefined ||
                source.commonDirectoryIdentity === undefined ||
                unknown
                  ? null
                  : candidates
                      .filter((workspace) =>
                        workspace.checkouts.some(
                          (checkout) =>
                            checkout.commonDirectory === source.commonDirectory &&
                            checkout.commonDirectoryIdentity === source.commonDirectoryIdentity,
                        ),
                      )
                      .map((workspace) => workspace.workspaceId);
              report = { ...report, derivedWorkspaceIds };
            }
            const available =
              isStillOnDisk(entry) && hasExpectedCheckoutIdentity(entry, substrate.gitEnv);
            if (entry.ownership === "adopted" && entry.available !== available)
              yield* substrate.registry.update((entries) =>
                entries.map((held) =>
                  held.workspaceId === workspaceId ? { ...held, available } : held,
                ),
              );
            return report;
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                ...failureReport(workspaceId, error),
                observedAt: new Date().toISOString(),
              }),
            ),
          );
          yield* startWorkspaceOperation(result, restore(observation), () =>
            observations.delete(workspaceId),
          );
          return yield* restore(Deferred.await(result));
        }),
      );

    const removalsInFlight = new Map<
      string,
      {
        readonly instruction: WorkspaceRemoval;
        readonly result: Deferred.Deferred<WorkspaceReport>;
      }
    >();
    const remove = (instruction: WorkspaceRemoval): Effect.Effect<WorkspaceReport> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const active = removalsInFlight.get(instruction.workspaceId);
          if (active !== undefined) {
            if (hasSameRemovalIntent(active.instruction, instruction))
              return yield* restore(Deferred.await(active.result));
            return failureReport(
              instruction.workspaceId,
              new Error(
                "A different removal request is pending. Retry the original request before changing the removal intent.",
              ),
              instruction.requestId,
            );
          }
          const preparation = inFlight.get(instruction.workspaceId);
          const result = Deferred.makeUnsafe<WorkspaceReport>();
          removalsInFlight.set(instruction.workspaceId, { instruction, result });
          const work = Effect.gen(function* () {
            if (preparation !== undefined) yield* Deferred.await(preparation.result);
            return yield* instruction._tag === "workspaceDispose"
              ? disposeWorkspace(substrate, instruction)
              : detachWorkspace(substrate, instruction);
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed(failureReport(instruction.workspaceId, error, instruction.requestId)),
            ),
          );
          yield* startWorkspaceOperation(result, restore(work), () =>
            removalsInFlight.delete(instruction.workspaceId),
          );
          return yield* restore(Deferred.await(result));
        }),
      );

    const workspaces: Workspaces = {
      provision: (frame) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (removalsInFlight.has(frame.workspaceId))
              return failureReport(
                frame.workspaceId,
                new Error(
                  "Workspace removal is in progress. Complete the removal request before creating a fresh workspace.",
                ),
              );
            const running = inFlight.get(frame.workspaceId);
            if (running !== undefined) {
              if (
                (running.instruction.attachment !== undefined || frame.attachment !== undefined) &&
                (JSON.stringify(running.instruction.attachment) !==
                  JSON.stringify(frame.attachment) ||
                  JSON.stringify(running.instruction.checkouts) !== JSON.stringify(frame.checkouts))
              )
                return failureReport(
                  frame.workspaceId,
                  new Error(
                    "A different checkout instruction is already being selected for this workspace. Repeat the original request.",
                  ),
                );
              return yield* restore(Deferred.await(running.result));
            }
            const result = Deferred.makeUnsafe<WorkspaceReport>();
            inFlight.set(frame.workspaceId, { instruction: frame, result });
            const work = Effect.gen(function* () {
              // Corrupt receipts cannot authorize changes to the registry or candidate files.
              const removal = yield* substrate.registry.readRemoval(frame.workspaceId);
              if (removal?.phase === "pending" || removal?.report?.status === "deleted")
                return yield* Effect.fail(
                  new Error(
                    "This workspace is being removed or its registration was deleted. Use a fresh workspace ID after completing removal.",
                  ),
                );
              const entry = yield* substrate.registry.held(frame.workspaceId);
              const resources = frame.checkouts.map((checkout) => checkout.resourceId);
              if (frame.attachment !== undefined)
                return yield* coordinateRepositorySelection(
                  resources,
                  attachWorkspace(substrate, frame),
                );
              if (entry?.ownership === "adopted")
                return yield* Effect.fail(
                  new Error(
                    "This workspace already has an existing checkout selected. Repeat the original attachment request.",
                  ),
                );
              if (entry !== undefined) return yield* reprovision(substrate, entry);
              yield* coordinateRepositorySelection(
                resources,
                reserveManagedRepositories(substrate, frame),
              );
              return yield* provisionWorkspace(substrate, frame);
            }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const held = yield* substrate.registry
                    .held(frame.workspaceId)
                    .pipe(Effect.catch(() => Effect.succeed(undefined)));
                  if (
                    held?.ownership === "adopted" &&
                    !hasExpectedCheckoutIdentity(held, substrate.gitEnv)
                  ) {
                    yield* substrate.registry.update((entries) =>
                      entries.map((entry) =>
                        entry.workspaceId === frame.workspaceId
                          ? { ...entry, available: false }
                          : entry,
                      ),
                    );
                    return yield* observeWorkspace(held, substrate.gitEnv);
                  }
                  return failureReport(frame.workspaceId, error);
                }),
              ),
              Effect.catch((error) => Effect.succeed(failureReport(frame.workspaceId, error))),
            );
            yield* startWorkspaceOperation(result, restore(work), () =>
              inFlight.delete(frame.workspaceId),
            );
            return yield* restore(Deferred.await(result));
          }),
        ),
      dispose: remove,
      detach: remove,
      resolve: (workspaceId) =>
        findStandingWorkspace(workspaceId).pipe(
          Effect.map((entry) =>
            entry === undefined
              ? undefined
              : { root: entry.root, cwd: chooseCwd(entry), checkouts: entry.checkouts },
          ),
        ),
      waitForProvisioning: (workspaceId) =>
        Effect.suspend(() => {
          const active = inFlight.get(workspaceId);
          return active === undefined ? Effect.void : Effect.asVoid(Deferred.await(active.result));
        }),
      hasFailedProvisioning: (workspaceId) =>
        Effect.gen(function* () {
          const preparation = (yield* substrate.registry.held(workspaceId))?.preparation;
          return (
            preparation !== undefined &&
            !inFlight.has(workspaceId) &&
            (preparation.phase !== "terminal" || preparation.report.status === "failed")
          );
        }).pipe(Effect.catch(() => Effect.succeed(false))),
      inspect,
      reportAfterSession: (workspaceId) =>
        Effect.gen(function* () {
          if (
            removalsInFlight.has(workspaceId) ||
            (yield* substrate.registry.held(workspaceId)) === undefined
          )
            return undefined;
          return yield* inspect(workspaceId);
        }),
      runExclusively: (workspaceId, work) =>
        Effect.gen(function* () {
          const entry = yield* substrate.registry
            .held(workspaceId)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          const keys = new Set<string>([`workspace:${workspaceId}`]);
          for (const checkout of entry?.checkouts ?? []) {
            try {
              keys.add(`index:${realpathSync(checkout.path)}`);
              const discovered = Bun.spawnSync(
                [
                  "git",
                  "-C",
                  checkout.path,
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                ],
                { env: { ...substrate.gitEnv }, stdout: "pipe", stderr: "pipe" },
              );
              const common =
                checkout.commonDirectory ??
                (discovered.exitCode === 0 ? discovered.stdout.toString().trim() : undefined);
              if (common !== undefined) keys.add(`git:${realpathSync(common)}`);
            } catch {
              // An unavailable checkout cannot supply a physical lock identity.
            }
          }
          return yield* [...keys]
            .sort()
            .reduceRight((held, key) => withRepositoryLock(key, held), work);
        }),
    };
    return workspaces;
  });
