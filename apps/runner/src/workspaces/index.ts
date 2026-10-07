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
  readonly provision: (frame: WorkspaceProvision) => Promise<WorkspaceReport>;
  /** Replays removal outcomes and refuses remaining files without recorded ownership. */
  readonly dispose: (frame: WorkspaceDispose) => Promise<WorkspaceReport>;
  /** Forgets an attached workspace registration without deleting working files. */
  readonly detach: (frame: WorkspaceDetach) => Promise<WorkspaceReport>;
  readonly resolve: (workspaceId: string) => Resolved | undefined;
  /**
   * Waits until the provisioning of this workspace that is in progress, if
   * any, has finished. The controller sends a workspace step right after the
   * provisioning frame of its workspace, and the step must not look for the
   * workspace before the provisioning has created it. Never rejects.
   */
  readonly waitForProvisioning: (workspaceId: string) => Promise<void>;
  /**
   * Checks whether the latest provisioning of this workspace on this runner
   * failed. The recorded failure survives runner restarts and is forgotten only
   * when the workspace is disposed.
   */
  readonly hasFailedProvisioning: (workspaceId: string) => boolean;
  /**
   * Reads current checkout facts, coalesced per workspace. Returns a failed
   * recovery report when this runner cannot read a valid workspace record.
   */
  readonly inspect: (workspaceId: string) => Promise<WorkspaceReport>;
  /** Reads checkout facts after a turn or exit; returns undefined for an unknown workspace. */
  readonly reportAfterSession: (workspaceId: string) => Promise<WorkspaceReport | undefined>;
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
}): Workspaces => {
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
  const coordinateRepository = <A>(key: string, work: () => Promise<A>): Promise<A> =>
    Effect.runPromise(
      withRepositoryLock(key, Effect.tryPromise({ try: work, catch: (error) => error })),
    );
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
    { readonly instruction: WorkspaceProvision; readonly result: Promise<WorkspaceReport> }
  >();
  const selectionRequests = new Map<string, Promise<void>>();
  const coordinateRepositorySelection = async <A>(
    resourceIds: ReadonlyArray<string>,
    work: () => Promise<A>,
  ): Promise<A> => {
    const resources = [...new Set(resourceIds)];
    const preceding = resources
      .map((id) => selectionRequests.get(id))
      .filter((wait): wait is Promise<void> => wait !== undefined);
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of resources) selectionRequests.set(id, completed);
    try {
      await Promise.all(preceding);
      return await work();
    } finally {
      release();
      for (const id of resources)
        if (selectionRequests.get(id) === completed) selectionRequests.delete(id);
    }
  };

  /**
   * Returns the registered workspace, or undefined if this runner does not have
   * it or its directories were removed from disk. A session cannot be placed in
   * a directory that no longer exists, so such a workspace counts as unknown.
   */
  const findStandingWorkspace = (workspaceId: string): RegisteredWorkspace | undefined => {
    if (removalsInFlight.has(workspaceId)) return undefined;
    let entry: RegisteredWorkspace | undefined;
    try {
      entry = substrate.registry.held(workspaceId);
    } catch {
      // Corrupt registry state cannot authorize a session to use a directory.
      return undefined;
    }
    return entry !== undefined &&
      (entry.preparation === undefined ||
        (entry.preparation.phase === "terminal" && entry.preparation.report.status === "ready")) &&
      isStillOnDisk(entry) &&
      hasExpectedCheckoutIdentity(entry, substrate.gitEnv)
      ? entry
      : undefined;
  };

  const observations = new Map<string, Promise<WorkspaceReport>>();
  const inspect = async (workspaceId: string): Promise<WorkspaceReport> => {
    const running = observations.get(workspaceId);
    if (running !== undefined) return running;
    const observation = (async (): Promise<WorkspaceReport> => {
      try {
        const entry = substrate.registry.held(workspaceId);
        if (entry === undefined)
          throw new Error(
            "This runner has no record of the workspace. Restore its registry before continuing.",
          );
        let report = await observeWorkspace(entry, substrate.gitEnv);
        const source =
          entry.kind === "primary" && entry.ownership === "adopted"
            ? entry.checkouts[0]
            : undefined;
        if (source !== undefined) {
          const candidates = substrate.registry
            .all()
            .filter(
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
          await substrate.registry.update((entries) =>
            entries.map((held) =>
              held.workspaceId === workspaceId ? { ...held, available } : held,
            ),
          );
        return report;
      } catch (error) {
        return {
          _tag: "workspaceReport",
          workspaceId,
          status: "failed",
          observedAt: new Date().toISOString(),
          message: (error instanceof Error ? error.message : String(error)).slice(
            0,
            MAX_MESSAGE_LENGTH,
          ),
        };
      }
    })();
    observations.set(workspaceId, observation);
    try {
      return await observation;
    } finally {
      observations.delete(workspaceId);
    }
  };

  const removalsInFlight = new Map<
    string,
    { instruction: WorkspaceRemoval; result: Promise<WorkspaceReport> }
  >();
  const remove = (instruction: WorkspaceRemoval): Promise<WorkspaceReport> => {
    const active = removalsInFlight.get(instruction.workspaceId);
    if (active !== undefined) {
      if (hasSameRemovalIntent(active.instruction, instruction)) return active.result;
      return Promise.resolve({
        _tag: "workspaceReport",
        workspaceId: instruction.workspaceId,
        status: "failed",
        ...(instruction.requestId === undefined ? {} : { requestId: instruction.requestId }),
        message:
          "A different removal request is pending. Retry the original request before changing the removal intent.",
      });
    }
    const result = (async (): Promise<WorkspaceReport> => {
      try {
        await inFlight.get(instruction.workspaceId)?.result;
        return await (instruction._tag === "workspaceDispose"
          ? disposeWorkspace(substrate, instruction)
          : detachWorkspace(substrate, instruction));
      } catch (error) {
        return {
          _tag: "workspaceReport",
          workspaceId: instruction.workspaceId,
          status: "failed",
          ...(instruction.requestId === undefined ? {} : { requestId: instruction.requestId }),
          message: (error instanceof Error ? error.message : String(error)).slice(
            0,
            MAX_MESSAGE_LENGTH,
          ),
        };
      }
    })();
    removalsInFlight.set(instruction.workspaceId, { instruction, result });
    void result.finally(() => removalsInFlight.delete(instruction.workspaceId));
    return result;
  };

  return {
    provision: async (frame) => {
      if (removalsInFlight.has(frame.workspaceId))
        return {
          _tag: "workspaceReport",
          workspaceId: frame.workspaceId,
          status: "failed",
          message:
            "Workspace removal is in progress. Complete the removal request before creating a fresh workspace.",
        };
      const running = inFlight.get(frame.workspaceId);
      if (running !== undefined) {
        if (
          (running.instruction.attachment !== undefined || frame.attachment !== undefined) &&
          (JSON.stringify(running.instruction.attachment) !== JSON.stringify(frame.attachment) ||
            JSON.stringify(running.instruction.checkouts) !== JSON.stringify(frame.checkouts))
        ) {
          return {
            _tag: "workspaceReport",
            workspaceId: frame.workspaceId,
            status: "failed",
            message:
              "A different checkout instruction is already being selected for this workspace. Repeat the original request.",
          };
        }
        return running.result;
      }
      const started = (async (): Promise<WorkspaceReport> => {
        try {
          // Read before any Git inspection so corruption cannot alter the registry or candidate files.
          const removal = substrate.registry.readRemoval(frame.workspaceId);
          if (removal?.phase === "pending" || removal?.report?.status === "deleted")
            throw new Error(
              "This workspace is being removed or its registration was deleted. Use a fresh workspace ID after completing removal.",
            );
          const entry = substrate.registry.held(frame.workspaceId);
          const resources = frame.checkouts.map((checkout) => checkout.resourceId);
          if (frame.attachment !== undefined)
            return await coordinateRepositorySelection(resources, () =>
              attachWorkspace(substrate, frame),
            );
          if (entry?.ownership === "adopted")
            throw new Error(
              "This workspace already has an existing checkout selected. Repeat the original attachment request.",
            );
          if (entry !== undefined) return await reprovision(substrate, entry);
          await coordinateRepositorySelection(resources, () =>
            reserveManagedRepositories(substrate, frame),
          );
          return await provisionWorkspace(substrate, frame);
        } catch (error) {
          let held: RegisteredWorkspace | undefined;
          try {
            held = substrate.registry.held(frame.workspaceId);
          } catch {
            /* Recovery errors remain failed reports. */
          }
          if (
            held?.ownership === "adopted" &&
            !hasExpectedCheckoutIdentity(held, substrate.gitEnv)
          ) {
            await substrate.registry.update((entries) =>
              entries.map((entry) =>
                entry.workspaceId === frame.workspaceId ? { ...entry, available: false } : entry,
              ),
            );
            return observeWorkspace(held, substrate.gitEnv);
          }
          return {
            _tag: "workspaceReport",
            workspaceId: frame.workspaceId,
            status: "failed",
            message: (error instanceof Error ? error.message : String(error)).slice(
              0,
              MAX_MESSAGE_LENGTH,
            ),
          };
        }
      })();
      inFlight.set(frame.workspaceId, { instruction: frame, result: started });
      try {
        return await started;
      } finally {
        inFlight.delete(frame.workspaceId);
      }
    },
    dispose: remove,
    detach: remove,
    resolve: (workspaceId) => {
      const entry = findStandingWorkspace(workspaceId);
      return entry === undefined
        ? undefined
        : { root: entry.root, cwd: chooseCwd(entry), checkouts: entry.checkouts };
    },
    waitForProvisioning: async (workspaceId) => {
      await inFlight.get(workspaceId)?.result.catch(() => undefined);
    },
    hasFailedProvisioning: (workspaceId) => {
      try {
        const preparation = substrate.registry.held(workspaceId)?.preparation;
        return (
          preparation !== undefined &&
          !inFlight.has(workspaceId) &&
          (preparation.phase !== "terminal" || preparation.report.status === "failed")
        );
      } catch {
        // Without a readable receipt there is no recorded failure to replay.
        // Resolution still refuses the directory, so a step returns an error.
        return false;
      }
    },
    inspect,
    reportAfterSession: async (workspaceId) => {
      if (removalsInFlight.has(workspaceId) || substrate.registry.held(workspaceId) === undefined)
        return undefined;
      return inspect(workspaceId);
    },
    runExclusively: (workspaceId, work) =>
      Effect.suspend(() => {
        const entry = substrate.registry.held(workspaceId);
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
        return [...keys].sort().reduceRight((held, key) => withRepositoryLock(key, held), work);
      }),
  };
};
