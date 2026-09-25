/**
 * Workspaces on this runner, built on git: provisions a workspace when the
 * controller asks for one, finds its directory afterwards, and tears it down
 * (spec 03 sections 6.1-6.6).
 *
 * The controller sends workspace ids and the runner works out the paths. The
 * registry on this runner, not the controller, records where each workspace is.
 */
import type { WorkspaceDispose, WorkspaceProvision, WorkspaceReport } from "@hercule/protocol";
import { disposeWorkspace } from "./dispose";
import { provisionWorkspace, reprovision } from "./provision";
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
   * Reads a primary's current branch and its branches again, after a session
   * ran in it. Returns undefined for an ephemeral workspace or an unknown id.
   */
  readonly reportAfterSession: (workspaceId: string) => Promise<WorkspaceReport | undefined>;
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
   * The provisioning in progress, per workspace id. The controller resends a
   * provisioning frame to a runner that reconnects, and the resent frame can
   * arrive while the first provisioning is still cloning. The registry is
   * written only near the end, so both would find no entry and both would
   * provision: the second would fail on the branch the first had just created,
   * and then tear down what it found. So a second call waits for the one in
   * progress and returns the same report, which is what the controller would
   * have got if the frame had been sent only once.
   */
  const inFlight = new Map<string, Promise<WorkspaceReport>>();
  /**
   * Returns the registered workspace, or undefined if this runner does not have
   * it or its directories were removed from disk. A session cannot be placed in
   * a directory that no longer exists, so such a workspace counts as unknown.
   */
  const findStandingWorkspace = (workspaceId: string): RegisteredWorkspace | undefined => {
    const entry = substrate.registry.held(workspaceId);
    return entry !== undefined && isStillOnDisk(entry) ? entry : undefined;
  };

  return {
    provision: async (frame) => {
      const running = inFlight.get(frame.workspaceId);
      if (running !== undefined) return running;
      // The controller resends a provisioning frame to a runner that reconnects.
      // A workspace that already exists is reported again, not created again,
      // so the work in it survives the resend.
      const entry = substrate.registry.held(frame.workspaceId);
      const started =
        entry === undefined ? provisionWorkspace(substrate, frame) : reprovision(substrate, entry);
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
    reportAfterSession: async (workspaceId) => {
      const entry = findStandingWorkspace(workspaceId);
      return entry === undefined || entry.kind !== "primary"
        ? undefined
        : reprovision(substrate, entry);
    },
  };
};
