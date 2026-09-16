/**
 * The frame that asks a machine to make a workspace.
 *
 * It is built here rather than in either caller because both of them ask for
 * one: `workspace.provision` for a repo's shared checkout, and `session.spawn`
 * for a thread's own worktree. What the machine needs beyond the rows - the
 * remote to clone, the setup command to run, whether to copy what
 * `.workspaceinclude` lists - is the resource's, so the resource is handed in
 * beside the checkout.
 *
 * The folder to adopt in place is the one path that crosses this boundary. It
 * comes from the request and goes to the machine; nothing writes it down.
 */
import type { WorkspaceProvision } from "@hydra/protocol";
import type { StoredRepo } from "../resources";
import type { StoredCheckout, StoredWorkspace } from "./repository";

/** One working copy to ask for: the row, the repo behind it, and the words the
 * row has no column for. */
export interface CheckoutPlan {
  readonly checkout: StoredCheckout;
  readonly resource: StoredRepo;
  /** A folder on the machine to adopt rather than clone. */
  readonly path?: string;
  /** What a new branch starts from; absent takes the resource's default. */
  readonly baseBranch?: string;
}

export const provisionFrame = (
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
    ...(plan.path === undefined ? {} : { path: plan.path }),
    subdirectory: plan.checkout.subdirectory,
    branch: plan.checkout.branch,
    baseBranch: plan.baseBranch ?? null,
    setupCommand: plan.resource.setupCommand,
    workspaceInclude: plan.resource.workspaceInclude,
  })),
});
