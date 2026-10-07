/** Validates existing checkouts without changing their files or Git configuration. */
import { realpathSync, statSync } from "node:fs";
import * as Schema from "effect/Schema";
import {
  canonicalizeRemote,
  GitRemoteName,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import { runGit, type GitEnv } from "./git";
import { observeWorkspace } from "./provision";
import { isStillOnDisk, type RegisteredWorkspace, type RepositorySelection } from "./registry";
import type { Substrate } from "./substrate";

/** Returns the normalized checkout root and common Git directory, or fails with a recovery action. */
const inspectCheckoutIdentity = async (
  path: string,
  remoteName: string,
  remote: string,
  env: GitEnv,
): Promise<{ root: string; commonDirectory: string; commonDirectoryIdentity: string }> => {
  if (!Schema.is(GitRemoteName)(remoteName))
    throw new Error("The selected remote name is invalid. Choose an existing Git remote.");
  let chosen: string;
  try {
    chosen = realpathSync(path);
  } catch {
    throw new Error(
      "The selected checkout path is unavailable. Restore it and attach the same path again.",
    );
  }
  const root = await runGit(["-C", chosen, "rev-parse", "--show-toplevel"], { env });
  const common = await runGit(
    ["-C", chosen, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { env },
  );
  const configured = await runGit(["-C", chosen, "config", "--get", `remote.${remoteName}.url`], {
    env,
  });
  if (!root.ok || !common.ok)
    throw new Error(
      "The selected path is not an available Git checkout. Restore the repository before attaching it.",
    );
  if (
    !configured.ok ||
    canonicalizeRemote(configured.stdout) !== canonicalizeRemote(remote) ||
    canonicalizeRemote(remote) === undefined
  )
    throw new Error(
      "The selected checkout remote does not match the resource repository. Choose the correct path and remote.",
    );
  const commonDirectory = realpathSync(common.stdout);
  const physical = statSync(commonDirectory);
  return {
    root: realpathSync(root.stdout),
    commonDirectory,
    commonDirectoryIdentity: `${String(physical.dev)}:${String(physical.ino)}`,
  };
};

/** Checks an attached checkout's current identity before admitting a session to its files. */
export const matchesAttachedCheckout = (entry: RegisteredWorkspace, env: GitEnv): boolean => {
  if (entry.ownership !== "existing") return true;
  const checkout = entry.checkouts[0];
  if (
    checkout === undefined ||
    checkout.commonDirectory === undefined ||
    checkout.remoteName === undefined
  )
    return false;
  try {
    if (realpathSync(entry.root) !== entry.root) return false;
    const inspect = (args: ReadonlyArray<string>): string | undefined => {
      const result = Bun.spawnSync(["git", "-C", entry.root, ...args], {
        env: { ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
    };
    const root = inspect(["rev-parse", "--show-toplevel"]);
    const common = inspect(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const remote = inspect(["config", "--get", `remote.${checkout.remoteName}.url`]);
    return (
      root !== undefined &&
      common !== undefined &&
      remote !== undefined &&
      realpathSync(root) === entry.root &&
      realpathSync(common) === checkout.commonDirectory &&
      `${String(statSync(common).dev)}:${String(statSync(common).ino)}` ===
        checkout.commonDirectoryIdentity &&
      canonicalizeRemote(remote) === canonicalizeRemote(checkout.remote)
    );
  } catch {
    return false;
  }
};

/** Registers validated attachment intent and returns its preparation result without setup or fetch. */
export const attachWorkspace = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Promise<WorkspaceReport> => {
  const attachment = frame.attachment;
  const checkout = frame.checkouts[0];
  if (
    attachment === undefined ||
    frame.kind !== "primary" ||
    frame.checkouts.length !== 1 ||
    checkout === undefined
  )
    throw new Error(
      "An existing checkout attachment requires a main workspace with exactly one repository.",
    );
  const held = substrate.registry.held(frame.workspaceId);
  const selection = substrate.registry.selectedRepository(checkout.resourceId);
  const previousInstruction = held?.preparation?.instruction;
  if (
    previousInstruction !== undefined &&
    (previousInstruction.attachment?.remoteName !== attachment.remoteName ||
      previousInstruction.checkouts[0]?.resourceId !== checkout.resourceId ||
      canonicalizeRemote(previousInstruction.checkouts[0]?.remote ?? "") !==
        canonicalizeRemote(checkout.remote))
  )
    throw new Error(
      "This workspace already has a different selected checkout. Repeat its original attachment request.",
    );
  if (
    selection?.mode === "managed" ||
    (selection === undefined &&
      substrate.registry
        .all()
        .some((workspace) =>
          workspace.checkouts.some((copy) => copy.resourceId === checkout.resourceId),
        ))
  )
    throw new Error(
      "Managed repository storage is already selected for this resource. Choose that repository's main workspace.",
    );
  const identity = await inspectCheckoutIdentity(
    attachment.path,
    attachment.remoteName,
    checkout.remote,
    substrate.gitEnv,
  );
  if (
    selection !== undefined &&
    (selection.sourceRoot !== identity.root ||
      selection.commonDirectory !== identity.commonDirectory ||
      selection.commonDirectoryIdentity !== identity.commonDirectoryIdentity ||
      selection.remoteName !== attachment.remoteName ||
      selection.primaryWorkspaceId !== frame.workspaceId)
  )
    throw new Error(
      "A different checkout is already selected for this resource. Repeat the original attachment path and remote.",
    );
  if (
    held !== undefined &&
    held.ownership === "existing" &&
    (held.checkouts[0]?.commonDirectory !== identity.commonDirectory ||
      held.checkouts[0]?.commonDirectoryIdentity !== identity.commonDirectoryIdentity)
  )
    throw new Error(
      "The attached checkout repository was replaced. Restore its original Git repository before continuing.",
    );
  const selected: RepositorySelection = {
    resourceId: checkout.resourceId,
    mode: "existing",
    sourceRoot: identity.root,
    commonDirectory: identity.commonDirectory,
    commonDirectoryIdentity: identity.commonDirectoryIdentity,
    primaryWorkspaceId: frame.workspaceId,
    remoteName: attachment.remoteName,
  };
  await substrate.registry.selectRepository(selected);
  const entry: RegisteredWorkspace = {
    workspaceId: frame.workspaceId,
    kind: "primary",
    root: identity.root,
    ownership: "existing",
    checkouts: [
      {
        checkoutId: checkout.checkoutId,
        resourceId: checkout.resourceId,
        remote: checkout.remote,
        path: identity.root,
        commonDirectory: identity.commonDirectory,
        commonDirectoryIdentity: identity.commonDirectoryIdentity,
        remoteName: attachment.remoteName,
      },
    ],
    preparation: { phase: "creating", instruction: frame },
  };
  let report: WorkspaceReport;
  if (
    held?.preparation?.phase === "terminal" &&
    held.preparation.report.status === "ready" &&
    isStillOnDisk(held)
  )
    report = held.preparation.report;
  else
    report = {
      ...(await observeWorkspace(entry, substrate.gitEnv)),
      ownership: "existing",
      path: identity.root,
    };
  await substrate.registry.update((entries) => [
    ...entries.filter((workspace) => workspace.workspaceId !== frame.workspaceId),
    { ...entry, preparation: { phase: "terminal", instruction: frame, report } },
  ]);
  return report;
};

/** Reserves managed mode before bootstrap and refuses unavailable recorded local sources. */
export const reserveManagedRepositories = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Promise<void> => {
  for (const checkout of frame.checkouts) {
    const selected = substrate.registry.selectedRepository(checkout.resourceId);
    if (checkout.repositoryWorkspaceId !== undefined) {
      const source = substrate.registry.held(checkout.repositoryWorkspaceId);
      if (
        source === undefined ||
        source.kind !== "primary" ||
        !source.checkouts.some((copy) => copy.resourceId === checkout.resourceId) ||
        !isStillOnDisk(source) ||
        !matchesAttachedCheckout(source, substrate.gitEnv)
      )
        throw new Error(
          "The selected local repository workspace is unavailable. Restore it before starting a new workspace.",
        );
      if (frame.kind === "primary")
        throw new Error(
          "A managed main workspace cannot use an existing repository workspace as a substitute.",
        );
      throw new Error(
        "Creating a new worktree from the selected local repository is unavailable. Use its main workspace until worktree creation is supported.",
      );
    }
    if (selected?.mode === "existing")
      throw new Error(
        "An existing checkout is already selected for this resource. Use its recorded repository workspace to create a worktree.",
      );
    if (selected !== undefined) continue;
    const legacy = substrate.registry
      .all()
      .find(
        (workspace) =>
          workspace.kind === "primary" &&
          isStillOnDisk(workspace) &&
          (workspace.preparation === undefined ||
            (workspace.preparation.phase === "terminal" &&
              workspace.preparation.report.status === "ready")) &&
          workspace.checkouts.some((copy) => copy.resourceId === checkout.resourceId),
      );
    if (legacy !== undefined) {
      const source = legacy.checkouts.find((copy) => copy.resourceId === checkout.resourceId)!;
      const identity = await inspectCheckoutIdentity(
        legacy.root,
        source.remoteName ?? "origin",
        source.remote,
        substrate.gitEnv,
      );
      await substrate.registry.selectRepository({
        resourceId: checkout.resourceId,
        mode: "managed",
        commonDirectory: identity.commonDirectory,
        commonDirectoryIdentity: identity.commonDirectoryIdentity,
        sourceRoot: identity.root,
        primaryWorkspaceId: legacy.workspaceId,
        remoteName: source.remoteName ?? "origin",
      });
      continue;
    }
    await substrate.registry.selectRepository({
      resourceId: checkout.resourceId,
      mode: "managed",
      commonDirectory: null,
      sourceRoot: null,
      primaryWorkspaceId: frame.kind === "primary" ? frame.workspaceId : null,
      remoteName: "origin",
    });
  }
};
