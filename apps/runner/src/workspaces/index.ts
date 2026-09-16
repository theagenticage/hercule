/**
 * The git substrate: what this machine makes when the controller asks for a
 * workspace, where it is afterwards, and what is left when it is torn down
 * (spec 03 sections 6.1-6.6).
 *
 * Ids come in and paths go out. The registry, not the controller, is what
 * remembers where a workspace is.
 */
import type { WorkspaceDispose, WorkspaceProvision, WorkspaceReport } from "@hydra/protocol";
import { disposeWorkspace } from "./dispose";
import { provisionWorkspace, reprovision } from "./provision";
import {
  makeRegistry,
  stillOnDisk,
  type RegisteredCheckout,
  type RegisteredWorkspace,
} from "./registry";
import { SETUP_DEADLINE_MS, substrateEnv, type Substrate } from "./substrate";

export { switchBranch } from "./git";
export { substrateEnv } from "./substrate";

/** Where one workspace's work happens, as a session is placed into it. */
export interface Resolved {
  readonly root: string;
  readonly cwd: string;
  readonly checkouts: ReadonlyArray<RegisteredCheckout>;
}

export interface Workspaces {
  /** Idempotent: a workspace this machine already holds is re-reported, not remade. */
  readonly provision: (frame: WorkspaceProvision) => Promise<WorkspaceReport>;
  /** Idempotent: an id this machine never held is already disposed. */
  readonly dispose: (frame: WorkspaceDispose) => Promise<WorkspaceReport>;
  readonly resolve: (workspaceId: string) => Resolved | undefined;
  /** A primary's branch and branches, re-read; nothing for an ephemeral or an unknown id. */
  readonly reportAfterSession: (workspaceId: string) => Promise<WorkspaceReport | undefined>;
}

/**
 * One repository in the workspace means the work happens in it; several mean it
 * happens above them, which is the only place both are in view.
 */
const cwdOf = (entry: RegisteredWorkspace): string =>
  entry.checkouts.length === 1 ? entry.checkouts[0]!.path : entry.root;

export const makeWorkspaces = (options: {
  readonly storageDir: string;
  /** What the runner's own git and setup commands run with, over a scrubbed environment. */
  readonly gitEnv?: Record<string, string>;
  /** The shipped deadline for a setup command unless a test says otherwise. */
  readonly setupDeadlineMs?: number;
}): Workspaces => {
  const substrate: Substrate = {
    storageDir: options.storageDir,
    registry: makeRegistry(options.storageDir),
    gitEnv: substrateEnv(process.env, options.gitEnv),
    setupDeadlineMs: options.setupDeadlineMs ?? SETUP_DEADLINE_MS,
  };

  /**
   * What is being made right now, per workspace. The controller re-sends a
   * provisioning frame to a machine that dialled in again, and that resend can
   * land while the first one is still cloning: the registry is written at the
   * end, so both would see nothing there and both would provision, the second
   * one failing on the branch the first had just made and tearing down what it
   * found. Whoever arrives second waits for the one in flight and reports what
   * it reported, which is the same answer the controller would have got had the
   * frame never been sent twice.
   */
  const inFlight = new Map<string, Promise<WorkspaceReport>>();
  /**
   * A workspace whose directory somebody removed underneath the machine is one
   * no session can be placed in, and re-reporting it would place one there.
   */
  const standing = (workspaceId: string): RegisteredWorkspace | undefined => {
    const entry = substrate.registry.held(workspaceId);
    return entry !== undefined && stillOnDisk(entry) ? entry : undefined;
  };

  return {
    provision: async (frame) => {
      const running = inFlight.get(frame.workspaceId);
      if (running !== undefined) return running;
      // The controller resends a provisioning frame to a runner that dialled in
      // again, and the work in a workspace must survive that.
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
      // A dispose that overtook the provisioning it is disposing of would tear
      // down a directory git was still writing into, and the provisioning would
      // then register what the dispose had just removed. The outcome of the one
      // in flight is not this frame's answer - this frame's answer is what the
      // teardown after it makes of the workspace.
      await inFlight.get(frame.workspaceId)?.catch(() => undefined);
      return disposeWorkspace(substrate, frame);
    },
    resolve: (workspaceId) => {
      const entry = standing(workspaceId);
      return entry === undefined
        ? undefined
        : { root: entry.root, cwd: cwdOf(entry), checkouts: entry.checkouts };
    },
    reportAfterSession: async (workspaceId) => {
      const entry = standing(workspaceId);
      return entry === undefined || entry.kind !== "primary"
        ? undefined
        : reprovision(substrate, entry);
    },
  };
};
