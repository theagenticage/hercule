/** Validates existing checkouts without changing their files or Git configuration. */
import {
  canonicalizeRemote,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import { inspectCheckoutIdentity, hasExpectedCheckoutIdentity } from "./identity";
import { observeWorkspace } from "./inspection";
import { isStillOnDisk, type RegisteredWorkspace, type RepositorySelection } from "./registry";
import type { Substrate } from "./substrate";

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
        canonicalRoot: identity.root,
        commonDirectory: identity.commonDirectory,
        commonDirectoryIdentity: identity.commonDirectoryIdentity,
        remoteName: attachment.remoteName,
      },
    ],
    preparation: { phase: "creating", instruction: frame },
  };
  if (held?.preparation?.phase === "terminal" && held.preparation.report.status === "ready") {
    const report =
      held.available === false
        ? await observeWorkspace(held, substrate.gitEnv)
        : held.preparation.report;
    await substrate.registry.update((entries) =>
      entries.map((workspace) =>
        workspace.workspaceId === frame.workspaceId ? { ...workspace, available: true } : workspace,
      ),
    );
    return report;
  }
  const report: WorkspaceReport = {
    ...(await observeWorkspace(entry, substrate.gitEnv)),
    ownership: "existing",
    path: identity.root,
  };
  await substrate.registry.update((entries) => [
    ...entries.filter((workspace) => workspace.workspaceId !== frame.workspaceId),
    { ...entry, available: true, preparation: { phase: "terminal", instruction: frame, report } },
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
        !hasExpectedCheckoutIdentity(source, substrate.gitEnv)
      )
        throw new Error(
          "The selected local repository workspace is unavailable. Restore it before starting a new workspace.",
        );
      if (frame.kind === "primary")
        throw new Error(
          "A managed main workspace cannot use an existing repository workspace as a substitute.",
        );
      continue;
    }
    if (selected?.mode === "existing" && frame.kind === "primary")
      throw new Error(
        "An existing checkout is already selected for this resource. Use its registered main workspace.",
      );
    if (selected !== undefined) {
      const primary =
        selected.primaryWorkspaceId === null
          ? undefined
          : substrate.registry.held(selected.primaryWorkspaceId);
      if (
        frame.kind === "primary" &&
        (primary === undefined ||
          (primary.preparation?.phase === "terminal" &&
            primary.preparation.report.status === "failed"))
      ) {
        await substrate.registry.selectRepository({
          ...selected,
          primaryWorkspaceId: frame.workspaceId,
        });
      }
      continue;
    }
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
