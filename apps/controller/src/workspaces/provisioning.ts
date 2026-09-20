/**
 * Opening a workspace: the row, the checkouts inside it, the entry that records
 * it, and the frame that asks the machine to make it.
 *
 * It is one function rather than four steps at each call site, because both
 * openings - `workspace.provision` for a repo's main workspace, and a spawn that
 * wants a worktree of its own - have to write exactly the same things, and a
 * caller that forgot the audit row or spelled the payload differently would not
 * be caught by anything. What the machine needs beyond the rows - the remote to
 * clone, the setup command to run, whether to copy what `.workspaceinclude`
 * lists - is the resource's, so the resource is handed in beside the checkout.
 *
 * No path crosses this boundary. A primary is always a Hercule-managed clone
 * under the machine's own storage, so all the machine is ever told is which
 * repository to make it from.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { WorkspaceProvision } from "@hercule/protocol";
import type { Actor, CheckoutForm, WorkspaceKind } from "@hercule/contract";
import type { AuditLog } from "../events";
import type { StoredRepo } from "../resources";
import type { StoredCheckout, StoredWorkspace, workspaceRepository } from "./repository";

/** One working copy to ask for: the row, the repo behind it, and the words the
 * row has no column for. */
interface CheckoutPlan {
  readonly checkout: StoredCheckout;
  readonly resource: StoredRepo;
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
    subdirectory: plan.checkout.subdirectory,
    branch: plan.checkout.branch,
    baseBranch: plan.baseBranch ?? null,
    setupCommand: plan.resource.setupCommand,
    workspaceInclude: plan.resource.workspaceInclude,
  })),
});

/** One working copy a workspace is opened with. */
export interface OpeningCheckout {
  readonly resource: StoredRepo;
  readonly form: CheckoutForm;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  /** What a new branch starts from; absent takes the resource's default. */
  readonly baseBranch?: string;
}

/** The two writers this needs, which the service already holds. */
export interface WorkspaceWriters {
  readonly workspaces: Effect.Success<typeof workspaceRepository>;
  readonly audit: AuditLog["Service"];
}

export const openWorkspace = (
  writers: WorkspaceWriters,
  input: {
    readonly runnerId: string;
    readonly kind: WorkspaceKind;
    /** The Connection the work in it acts through, settled here and stored. */
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
    const workspace = yield* writers.workspaces.insert({
      runnerId: input.runnerId,
      kind: input.kind,
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
    return {
      workspace,
      frame: provisionFrame(
        workspace,
        input.checkouts.map((checkout, index) => ({
          checkout: rows[index]!,
          resource: checkout.resource,
          ...(checkout.baseBranch === undefined ? {} : { baseBranch: checkout.baseBranch }),
        })),
      ),
    };
  });

/**
 * The repo's own workspace on one machine, opened. Two openings ask for one -
 * `workspace.provision` by name, and a spawn that wants the main workspace -
 * and they have to write the same thing: a failed attempt stood down so this one
 * takes its place, the row, its single whole-repo checkout, and the entry.
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
  },
): Effect.Effect<
  { readonly workspace: StoredWorkspace; readonly frame: WorkspaceProvision },
  SqlError
> =>
  Effect.gen(function* () {
    // One that could not be made holds nothing; it is stood down here so this
    // one takes its place rather than living beside it.
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
