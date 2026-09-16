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
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { WorkspaceProvision } from "@hydra/protocol";
import type { Actor, CheckoutForm } from "@hydra/contract";
import type { AuditLog } from "../events";
import type { StoredRepo } from "../resources";
import type { StoredCheckout, StoredWorkspace, workspaceRepository } from "./repository";

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

/**
 * What opening a workspace writes, beyond the workspace row itself: its
 * checkouts, and the entry that records it. Both callers do exactly this, so
 * neither can forget the audit row or spell the payload differently.
 */
export interface OpeningCheckout {
  readonly resource: StoredRepo;
  readonly form: CheckoutForm;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  /** What a new branch starts from; absent takes the resource's default. */
  readonly baseBranch?: string;
  /** A folder on the machine to adopt rather than clone. */
  readonly path?: string;
}

/** The two writers this needs, which both callers already hold. */
export interface WorkspaceWriters {
  readonly workspaces: Effect.Success<typeof workspaceRepository>;
  readonly audit: AuditLog["Service"];
}

export const openWorkspace = (
  writers: WorkspaceWriters,
  input: {
    readonly workspace: StoredWorkspace;
    readonly checkouts: ReadonlyArray<OpeningCheckout>;
    readonly actor: Actor;
    readonly at: string;
  },
): Effect.Effect<WorkspaceProvision, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* writers.workspaces.insertCheckouts(
      input.workspace.id,
      input.checkouts.map((checkout) => ({
        resourceId: checkout.resource.id,
        form: checkout.form,
        subdirectory: checkout.subdirectory,
        branch: checkout.branch,
      })),
      input.at,
    );
    yield* writers.audit.append({
      kind: "workspace.created",
      actor: input.actor,
      payload: {
        workspaceId: input.workspace.id,
        runnerId: input.workspace.runnerId,
        kind: input.workspace.kind,
        resourceIds: input.checkouts.map((checkout) => checkout.resource.id),
      },
      at: input.at,
    });
    return provisionFrame(
      input.workspace,
      input.checkouts.map((checkout, index) => ({
        checkout: rows[index]!,
        resource: checkout.resource,
        ...(checkout.path === undefined ? {} : { path: checkout.path }),
        ...(checkout.baseBranch === undefined ? {} : { baseBranch: checkout.baseBranch }),
      })),
    );
  });

/**
 * The repo's own checkout on one machine, opened. Two operations ask for one -
 * `workspace.provision` by name, and a spawn that wants the shared checkout -
 * and they have to write the same thing: a failed attempt stood down so this
 * one takes its place, the row, its single whole-repo checkout, and the entry.
 *
 * Whether a primary already stands is the caller's to answer, because the two
 * answers differ: `workspace.provision` refuses it as a conflict, and a spawn
 * joins it.
 */
export const openPrimary = (
  writers: WorkspaceWriters,
  input: {
    readonly resource: StoredRepo;
    readonly runnerId: string;
    readonly actor: Actor;
    readonly at: string;
    /** A folder on the machine to adopt rather than clone. */
    readonly path?: string;
  },
): Effect.Effect<
  { readonly workspace: StoredWorkspace; readonly frame: WorkspaceProvision },
  SqlError
> =>
  Effect.gen(function* () {
    // One that could not be made holds nothing; it is stood down here so this
    // one takes its place rather than living beside it.
    yield* writers.workspaces.supersedeFailedPrimary(input.resource.id, input.runnerId, input.at);
    const workspace = yield* writers.workspaces.insert({
      runnerId: input.runnerId,
      kind: "primary",
      at: input.at,
    });
    const frame = yield* openWorkspace(writers, {
      workspace,
      // The shared checkout is a clone of the whole repo, on whatever branch it
      // is already on.
      checkouts: [
        {
          resource: input.resource,
          form: "clone",
          subdirectory: null,
          branch: null,
          ...(input.path === undefined ? {} : { path: input.path }),
        },
      ],
      actor: input.actor,
      at: input.at,
    });
    return { workspace, frame };
  });
