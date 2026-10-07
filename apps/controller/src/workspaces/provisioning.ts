/**
 * Opening a workspace: the workspace row, its checkout rows, the audit entry,
 * and the frame that asks the runner to create it.
 *
 * This is one function rather than four steps at each call site. Both callers -
 * `workspace.provision` for a repo's main workspace, and a spawn that wants a
 * worktree of its own - have to write exactly the same things, and nothing
 * would catch a caller that forgot the audit entry or built the payload
 * differently. The runner also needs values that come from the resource, not
 * the rows: the remote to clone, the setup command to run, and the
 * `.workspaceinclude` list. So the resource is passed in beside each checkout.
 *
 * Explicit attachment paths are scoped to the selected runner. Managed
 * workspaces continue to use runner-local storage.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { WorkspaceProvision } from "@hercule/protocol";
import type { Actor, CheckoutForm, WorkspaceKind } from "@hercule/contract";
import type { AuditLog } from "../events";
import type { StoredRepo } from "../resources";
import type { StoredCheckout, StoredWorkspace, workspaceRepository } from "./repository";

/** One checkout to ask the runner for: the row, and the repo behind it. */
interface CheckoutPlan {
  readonly checkout: StoredCheckout;
  readonly resource: StoredRepo;
  readonly repositoryWorkspaceId?: string;
}

/**
 * Builds a workspace's creation instruction from its initial checkouts and
 * Resources. The caller records the frame before sending it, so later Resource
 * edits cannot change a pending instruction.
 */
export const buildProvisionFrame = (
  workspace: StoredWorkspace,
  plans: ReadonlyArray<CheckoutPlan>,
): WorkspaceProvision => ({
  _tag: "workspaceProvision",
  workspaceId: workspace.id,
  kind: workspace.kind,
  checkouts: plans.map((plan) => ({
    checkoutId: plan.checkout.id,
    resourceId: plan.resource.id,
    remote: plan.resource.remote,
    subdirectory: plan.checkout.subdirectory,
    branch: plan.checkout.branch,
    baseBranch: plan.checkout.baseBranch,
    setupCommand: plan.resource.setupCommand,
    workspaceInclude: plan.resource.workspaceInclude,
    ...(plan.repositoryWorkspaceId === undefined
      ? {}
      : { repositoryWorkspaceId: plan.repositoryWorkspaceId }),
  })),
});

/** One checkout a workspace is opened with. */
export interface OpeningCheckout {
  readonly resource: StoredRepo;
  readonly form: CheckoutForm;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  /** The branch a new branch starts from; absent means the resource's default. */
  readonly baseBranch?: string;
  readonly repositoryWorkspaceId?: string;
}

/** The two writers that opening a workspace needs, which the service already holds. */
export interface WorkspaceWriters {
  readonly workspaces: Effect.Success<typeof workspaceRepository>;
  readonly audit: AuditLog["Service"];
}

export const openWorkspace = (
  writers: WorkspaceWriters,
  input: {
    readonly runnerId: string;
    readonly kind: WorkspaceKind;
    readonly attachment?: { readonly path: string; readonly remoteName: string };
    /** The Connection that work in the workspace acts through, fixed here and stored. */
    readonly designatedConnectionId: string | null;
    readonly checkouts: ReadonlyArray<OpeningCheckout>;
    readonly actor: Actor;
    readonly at: string;
  },
): Effect.Effect<
  { readonly workspace: StoredWorkspace; readonly frame: WorkspaceProvision },
  SqlError
> =>
  Effect.gen(function* () {
    for (const checkout of input.checkouts) {
      if (input.attachment === undefined && checkout.repositoryWorkspaceId === undefined) {
        yield* writers.workspaces.reserveRepositorySelection(checkout.resource.id, input.runnerId, {
          mode: "managed",
        });
      }
    }
    const workspace = yield* writers.workspaces.insert({
      runnerId: input.runnerId,
      kind: input.kind,
      ownership: input.attachment === undefined ? "managed" : "existing",
      designatedConnectionId: input.designatedConnectionId,
      at: input.at,
    });
    const rows = yield* writers.workspaces.insertCheckouts(
      workspace.id,
      input.checkouts.map((checkout) => ({
        resourceId: checkout.resource.id,
        form: checkout.form,
        subdirectory: checkout.subdirectory,
        branch: checkout.branch,
        baseBranch: checkout.baseBranch ?? null,
      })),
      input.at,
    );
    yield* writers.audit.append({
      kind: "workspace.created",
      actor: input.actor,
      payload: {
        workspaceId: workspace.id,
        runnerId: workspace.runnerId,
        kind: workspace.kind,
        resourceIds: input.checkouts.map((checkout) => checkout.resource.id),
      },
      at: input.at,
    });
    const creation = buildProvisionFrame(
      workspace,
      input.checkouts.map((checkout, index) => ({
        checkout: rows[index]!,
        resource: checkout.resource,
        ...(checkout.repositoryWorkspaceId === undefined
          ? {}
          : { repositoryWorkspaceId: checkout.repositoryWorkspaceId }),
      })),
    );
    const frame: WorkspaceProvision = {
      ...creation,
      ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
    };
    if (input.kind === "primary") {
      yield* writers.workspaces.setRepositoryPrimary(
        input.checkouts[0]!.resource.id,
        input.runnerId,
        workspace.id,
      );
    }
    yield* writers.workspaces.freezeProvisionFrame(workspace.id, frame);
    return { workspace, frame };
  });

/**
 * Opens a repo's primary workspace on one runner, and returns the workspace row
 * and the frame to send. Fails only on a database error. Two callers open a
 * primary - `workspace.provision`, and a spawn that wants the main workspace -
 * and both write the same things:
 *
 * - a failed earlier primary is marked `deleted`, so this one replaces it
 * - the workspace row, with its single whole-repo checkout
 * - the audit entry
 *
 * The caller checks whether a primary already exists, because the two callers
 * handle that differently: `workspace.provision` rejects it as a conflict, and
 * a spawn joins it.
 */
export const openPrimary = (
  writers: WorkspaceWriters,
  input: {
    readonly resource: StoredRepo;
    readonly runnerId: string;
    readonly actor: Actor;
    readonly at: string;
  },
): Effect.Effect<
  { readonly workspace: StoredWorkspace; readonly frame: WorkspaceProvision },
  SqlError
> =>
  Effect.gen(function* () {
    // A primary that failed to provision holds nothing. It is marked deleted
    // here so the new one replaces it rather than existing beside it.
    yield* writers.workspaces.supersedeFailedPrimary(input.resource.id, input.runnerId, input.at);
    return yield* openWorkspace(writers, {
      runnerId: input.runnerId,
      kind: "primary",
      designatedConnectionId: input.resource.connectionId,
      // The main workspace is a clone of the whole repo, on whatever branch it
      // comes up on.
      checkouts: [{ resource: input.resource, form: "clone", subdirectory: null, branch: null }],
      actor: input.actor,
      at: input.at,
    });
  });
