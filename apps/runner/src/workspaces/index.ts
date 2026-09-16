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
  const setupEnv = substrateEnv(process.env, options.gitEnv);
  const substrate: Substrate = {
    storageDir: options.storageDir,
    registry: makeRegistry(options.storageDir),
    gitEnv: setupEnv,
    setupEnv,
    setupDeadlineMs: options.setupDeadlineMs ?? SETUP_DEADLINE_MS,
  };
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
      // The controller resends a provisioning frame to a runner that dialled in
      // again, and the work in a workspace must survive that.
      const entry = substrate.registry.held(frame.workspaceId);
      return entry === undefined
        ? provisionWorkspace(substrate, frame)
        : reprovision(substrate, entry);
    },
    dispose: (frame) => disposeWorkspace(substrate, frame),
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
