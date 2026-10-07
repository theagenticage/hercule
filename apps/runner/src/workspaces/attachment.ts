/** Validates existing checkouts without changing their files or Git configuration. */
import * as Effect from "effect/Effect";
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
export const attachWorkspace = (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Effect.Effect<WorkspaceReport, Error> =>
  Effect.gen(function* () {
    const attachment = frame.attachment;
    const checkout = frame.checkouts[0];
    if (
      attachment === undefined ||
      frame.kind !== "primary" ||
      frame.checkouts.length !== 1 ||
      checkout === undefined
    )
      return yield* Effect.fail(
        new Error(
          "An existing checkout attachment requires a main workspace with exactly one repository.",
        ),
      );
    const held = yield* substrate.registry.held(frame.workspaceId);
    const selection = yield* substrate.registry.selectedRepository(checkout.resourceId);
    const previousInstruction = held?.preparation?.instruction;
    if (
      previousInstruction !== undefined &&
      (previousInstruction.attachment?.remoteName !== attachment.remoteName ||
        previousInstruction.checkouts[0]?.resourceId !== checkout.resourceId ||
        canonicalizeRemote(previousInstruction.checkouts[0]?.remote ?? "") !==
          canonicalizeRemote(checkout.remote))
    )
      return yield* Effect.fail(
        new Error(
          "This workspace already has a different selected checkout. Repeat its original attachment request.",
        ),
      );
    if (
      selection?.mode === "managed" ||
      (selection === undefined &&
        (yield* substrate.registry.all()).some((workspace) =>
          workspace.checkouts.some((copy) => copy.resourceId === checkout.resourceId),
        ))
    )
      return yield* Effect.fail(
        new Error(
          "Managed repository storage is already selected for this resource. Choose that repository's main workspace.",
        ),
      );
    const identity = yield* inspectCheckoutIdentity(
      attachment.path,
      attachment.remoteName,
      checkout.remote,
      substrate.gitEnv,
    );
    const previousRemoval =
      selection !== undefined &&
      selection.primaryWorkspaceId !== null &&
      selection.primaryWorkspaceId !== frame.workspaceId
        ? yield* substrate.registry.readRemoval(selection.primaryWorkspaceId)
        : undefined;
    if (
      selection !== undefined &&
      (selection.sourceRoot !== identity.root ||
        selection.commonDirectory !== identity.commonDirectory ||
        selection.commonDirectoryIdentity !== identity.commonDirectoryIdentity ||
        selection.remoteName !== attachment.remoteName ||
        (selection.primaryWorkspaceId !== frame.workspaceId &&
          !(
            selection.primaryWorkspaceId !== null &&
            previousRemoval?.instruction._tag === "workspaceDetach" &&
            previousRemoval?.report?.status === "deleted"
          )))
    )
      return yield* Effect.fail(
        new Error(
          "A different checkout is already selected for this resource. Repeat the original attachment path and remote.",
        ),
      );
    if (
      held !== undefined &&
      held.ownership === "adopted" &&
      (held.checkouts[0]?.commonDirectory !== identity.commonDirectory ||
        held.checkouts[0]?.commonDirectoryIdentity !== identity.commonDirectoryIdentity)
    )
      return yield* Effect.fail(
        new Error(
          "The attached checkout repository was replaced. Restore its original Git repository before continuing.",
        ),
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
    yield* substrate.registry.selectRepository(selected);
    const entry: RegisteredWorkspace = {
      workspaceId: frame.workspaceId,
      kind: "primary",
      root: identity.root,
      ownership: "adopted",
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
          ? yield* observeWorkspace(held, substrate.gitEnv)
          : held.preparation.report;
      yield* substrate.registry.update((entries) =>
        entries.map((workspace) =>
          workspace.workspaceId === frame.workspaceId
            ? { ...workspace, available: true }
            : workspace,
        ),
      );
      return report;
    }
    const report: WorkspaceReport = {
      ...(yield* observeWorkspace(entry, substrate.gitEnv)),
      ownership: "adopted",
      path: identity.root,
    };
    yield* substrate.registry.update((entries) => [
      ...entries.filter((workspace) => workspace.workspaceId !== frame.workspaceId),
      { ...entry, available: true, preparation: { phase: "terminal", instruction: frame, report } },
    ]);
    return report;
  });

/** Reserves managed mode before bootstrap and refuses unavailable recorded local sources. */
export const reserveManagedRepositories = (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (const checkout of frame.checkouts) {
      const selected = yield* substrate.registry.selectedRepository(checkout.resourceId);
      if (checkout.repositoryWorkspaceId !== undefined) {
        const source = yield* substrate.registry.held(checkout.repositoryWorkspaceId);
        if (
          source === undefined ||
          source.kind !== "primary" ||
          !source.checkouts.some((copy) => copy.resourceId === checkout.resourceId) ||
          !isStillOnDisk(source) ||
          !hasExpectedCheckoutIdentity(source, substrate.gitEnv)
        )
          return yield* Effect.fail(
            new Error(
              "The selected local repository workspace is unavailable. Restore it before starting a new workspace.",
            ),
          );
        if (frame.kind === "primary")
          return yield* Effect.fail(
            new Error(
              "A managed main workspace cannot use an existing repository workspace as a substitute.",
            ),
          );
        if (selected === undefined) {
          const sourceCheckout = source.checkouts.find(
            (copy) => copy.resourceId === checkout.resourceId,
          )!;
          const remoteName = sourceCheckout.remoteName ?? "origin";
          const identity = yield* inspectCheckoutIdentity(
            sourceCheckout.path,
            remoteName,
            checkout.remote,
            substrate.gitEnv,
          );
          yield* substrate.registry.selectRepository({
            resourceId: checkout.resourceId,
            mode: source.ownership === "adopted" ? "existing" : "managed",
            commonDirectory: identity.commonDirectory,
            commonDirectoryIdentity: identity.commonDirectoryIdentity,
            sourceRoot: identity.root,
            primaryWorkspaceId: source.workspaceId,
            remoteName,
          });
        }
        continue;
      }
      if (selected?.mode === "existing" && frame.kind === "primary")
        return yield* Effect.fail(
          new Error(
            "An existing checkout is already selected for this resource. Use its registered main workspace.",
          ),
        );
      if (selected !== undefined) {
        const primary =
          selected.primaryWorkspaceId === null
            ? undefined
            : yield* substrate.registry.held(selected.primaryWorkspaceId);
        if (
          frame.kind === "primary" &&
          (primary === undefined ||
            (primary.preparation?.phase === "terminal" &&
              primary.preparation.report.status === "failed"))
        ) {
          yield* substrate.registry.selectRepository({
            ...selected,
            primaryWorkspaceId: frame.workspaceId,
          });
        }
        continue;
      }
      const legacy = (yield* substrate.registry.all()).find(
        (workspace) =>
          workspace.kind === "primary" &&
          (workspace.preparation === undefined ||
            (workspace.preparation.phase === "terminal" &&
              workspace.preparation.report.status === "ready")) &&
          workspace.checkouts.some((copy) => copy.resourceId === checkout.resourceId),
      );
      if (legacy !== undefined) {
        const source = legacy.checkouts.find((copy) => copy.resourceId === checkout.resourceId)!;
        const identity = yield* inspectCheckoutIdentity(
          legacy.root,
          source.remoteName ?? "origin",
          source.remote,
          substrate.gitEnv,
        );
        yield* substrate.registry.selectRepository({
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
      yield* substrate.registry.selectRepository({
        resourceId: checkout.resourceId,
        mode: "managed",
        commonDirectory: null,
        sourceRoot: null,
        primaryWorkspaceId: frame.kind === "primary" ? frame.workspaceId : null,
        remoteName: "origin",
      });
    }
  });
