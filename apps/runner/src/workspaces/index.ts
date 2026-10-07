/**
 * Workspaces on this runner, built on git: provisions a workspace when the
 * controller asks for one, finds its directory afterwards, and tears it down
 * (spec 03 sections 6.1-6.6).
 *
 * The controller sends workspace ids and the runner works out the paths. The
 * registry on this runner, not the controller, records where each workspace is.
 */
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_MESSAGE_LENGTH,
  type WorkspaceDispose,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import { disposeWorkspace } from "./dispose";
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
  /** Idempotent: disposing an id this runner never had reports it as deleted. */
  readonly dispose: (frame: WorkspaceDispose) => Promise<WorkspaceReport>;
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
   * Reads a primary's current branch and its branches again, after a session
   * ran in it. Returns undefined for an ephemeral workspace or an unknown id.
   */
  readonly reportAfterSession: (workspaceId: string) => Promise<WorkspaceReport | undefined>;
  /**
   * Runs `work` once no other work given here for the same workspace is
   * running, and returns its result. Work for different workspaces runs side
   * by side. Wrap every git command that writes to a workspace's checkouts:
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
  const substrate: Substrate = {
    storageDir: options.storageDir,
    registry: makeRegistry(options.storageDir),
    gitEnv: buildSubstrateEnv(process.env, options.gitEnv),
    setupDeadlineMs: options.setupDeadlineMs ?? SETUP_DEADLINE_MS,
  };

  /**
   * Coalesces duplicate delivery while preparation is active. A second request
   * must wait for the original result rather than treating its recorded
   * in-progress phase as an interrupted preparation.
   */
  const inFlight = new Map<string, Promise<WorkspaceReport>>();
  /**
   * The lock of each workspace that has work running or waiting in
   * `runExclusively`, with the number of callers holding or waiting for it.
   * A lock is removed when its last caller is done, so the map does not grow
   * with every workspace this runner has ever had. The count makes that safe:
   * a lock is never removed while a caller still waits for it, which would
   * let the next caller make a second lock and run beside the first.
   */
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  /**
   * Returns the registered workspace, or undefined if this runner does not have
   * it or its directories were removed from disk. A session cannot be placed in
   * a directory that no longer exists, so such a workspace counts as unknown.
   */
  const findStandingWorkspace = (workspaceId: string): RegisteredWorkspace | undefined => {
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
      isStillOnDisk(entry)
      ? entry
      : undefined;
  };

  return {
    provision: async (frame) => {
      const running = inFlight.get(frame.workspaceId);
      if (running !== undefined) return running;
      const started = (async (): Promise<WorkspaceReport> => {
        try {
          const entry = substrate.registry.held(frame.workspaceId);
          return await (entry === undefined
            ? provisionWorkspace(substrate, frame)
            : reprovision(substrate, entry));
        } catch (error) {
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
      inFlight.set(frame.workspaceId, started);
      try {
        return await started;
      } finally {
        inFlight.delete(frame.workspaceId);
      }
    },
    dispose: async (frame) => {
      // Wait for any provisioning of this workspace to finish first. Otherwise
      // the teardown could remove a directory git is still writing into, and
      // the provisioning would then register the directory the teardown had
      // just removed. The provisioning's result is ignored: this call reports
      // the result of the teardown.
      await inFlight.get(frame.workspaceId)?.catch(() => undefined);
      return disposeWorkspace(substrate, frame);
    },
    resolve: (workspaceId) => {
      const entry = findStandingWorkspace(workspaceId);
      return entry === undefined
        ? undefined
        : { root: entry.root, cwd: chooseCwd(entry), checkouts: entry.checkouts };
    },
    waitForProvisioning: async (workspaceId) => {
      await inFlight.get(workspaceId)?.catch(() => undefined);
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
    reportAfterSession: async (workspaceId) => {
      const entry = findStandingWorkspace(workspaceId);
      return entry === undefined || entry.kind !== "primary"
        ? undefined
        : observeWorkspace(entry, substrate.gitEnv);
    },
    runExclusively: (workspaceId, work) =>
      Effect.suspend(() => {
        const entry = locks.get(workspaceId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(workspaceId, entry);
        entry.users += 1;
        return entry.lock
          .withPermits(1)(work)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.users -= 1;
                if (entry.users === 0) locks.delete(workspaceId);
              }),
            ),
          );
      }),
  };
};
