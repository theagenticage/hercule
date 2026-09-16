/**
 * Workspaces: the provisioned working areas on a machine that sessions do their
 * work in, and the checkouts inside them.
 *
 * A workspace is a kind and a list of checkouts; every git word - the branch, a
 * subdirectory, how the copy was made - lives on a checkout. A primary is the
 * resource's own long-lived checkout on that machine, shared by whatever runs
 * in it and never torn down; an ephemeral one is made for a piece of work and
 * disposed of afterwards.
 *
 * The controller stores no path. Where the folder is is the machine's own
 * business, and the one path a caller may name - a folder to adopt in place -
 * is forwarded to that machine and never written down here.
 */
import { Schema } from "effect";
import { CheckoutForm, WorkspaceKind } from "@hydra/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";

/** The kinds and the forms are the wire's; the API hands them out unchanged. */
export { CheckoutForm, WorkspaceKind };

/** The longest path a caller may point at to adopt in place. */
export const MAX_PATH_LENGTH = 512;

/** The longest branch name; git's own limit is the filesystem's. */
export const MAX_BRANCH_LENGTH = 255;

/**
 * A branch name git will take, checked here rather than on a machine: what a
 * caller writes ends up in `git checkout` and `git worktree add`, so a word
 * beginning with `-` would be read as an option, and the rest of these are what
 * `git check-ref-format` refuses - `..` and `@{` have meanings of their own, a
 * control character or a space is not a name, `~^:?*[\` are pattern and
 * revision syntax, and a trailing `/` or `.lock` is not a ref.
 */
export const Branch = Schema.String.check(
  Schema.isLengthBetween(1, MAX_BRANCH_LENGTH),
  // The control characters are the point: git refuses them in a ref name, and
  // a name is checked here rather than by a command that half ran.
  Schema.isPattern(
    // eslint-disable-next-line no-control-regex
    /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)[^\u0000-\u0020~^:?*[\\\u007f]+$/,
    { title: "branch", description: "a git branch name" },
  ),
);

/**
 * A folder on the machine, as the user points at it: absolute, because the
 * machine has no working directory the user can see, and never something git
 * would read as an option.
 */
export const AdoptPath = Schema.String.check(
  Schema.isLengthBetween(1, MAX_PATH_LENGTH),
  // A path is what it says it is, absolutely: the machine has no working
  // directory the user can see, and a word beginning with `-` is an option. The
  // NUL is the point, as above: it cannot be in a path.
  // eslint-disable-next-line no-control-regex
  Schema.isPattern(/^\/[^\u0000]*$/, {
    title: "path",
    description: "an absolute path on the machine",
  }),
);

/**
 * Where a workspace stands. `failed` and `lost` are both dead ends a machine
 * put it in: one could not be made, the other was on a machine that was
 * retired.
 */
export const WORKSPACE_STATUSES = ["provisioning", "ready", "failed", "deleted", "lost"] as const;

export const WorkspaceStatus = Schema.Literals(WORKSPACE_STATUSES);

export type WorkspaceStatus = Schema.Schema.Type<typeof WorkspaceStatus>;

/** One working copy of one resource inside a workspace. */
export const Checkout = Schema.Struct({
  checkoutId: Id,
  resourceId: Id,
  form: CheckoutForm,
  /** Where under the workspace it sits; null puts it at the root. */
  subdirectory: Schema.NullOr(Schema.String),
  /** What is checked out there, once the machine has said. */
  branch: Schema.NullOr(Branch),
  /** Every local branch the machine found, in its order. */
  branches: Schema.Array(Branch),
  defaultBranch: Schema.NullOr(Branch),
});

export type Checkout = Schema.Schema.Type<typeof Checkout>;

export const Workspace = Schema.Struct({
  id: Id,
  /** Pinned where it was made: a workspace never moves. */
  runnerId: Id,
  kind: WorkspaceKind,
  status: WorkspaceStatus,
  checkouts: Schema.Array(Checkout),
  /** The Connection its first checkout's resource names; null on a scratch one. */
  designatedConnectionId: Schema.NullOr(Id),
  /** What the machine said when it could not make it. */
  message: Schema.NullOr(Schema.String),
  /** The sessions in it that have not exited. */
  sessionIds: Schema.Array(Id),
  createdAt: Timestamp,
  provisionedAt: Schema.NullOr(Timestamp),
  /** Set at provisioning and at every session start and exit in it. */
  lastUsedAt: Schema.NullOr(Timestamp),
  disposedAt: Schema.NullOr(Timestamp),
});

export type Workspace = Schema.Schema.Type<typeof Workspace>;

export const WORKSPACE_SORT_FIELDS = ["createdAt"] as const;

/**
 * Provisioning a primary: the resource's own checkout on one machine. An
 * ephemeral workspace is never provisioned on its own - it is made for the
 * session that asked for it, by `session.spawn`.
 */
export const WorkspaceProvisionInput = closedStruct({
  resourceId: Id,
  runnerId: Id,
  /**
   * A folder on that machine to adopt in place, instead of cloning a fresh one.
   * Forwarded to the machine and never stored.
   */
  path: Schema.optionalKey(AdoptPath),
});

export type WorkspaceProvisionInput = Schema.Schema.Type<typeof WorkspaceProvisionInput>;

export const WorkspaceFilter = Schema.Struct({
  runnerId: Schema.optionalKey(Id),
  resourceId: Schema.optionalKey(Id),
  projectId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(WorkspaceKind),
  status: Schema.optionalKey(WorkspaceStatus),
});

export const workspace = HttpApiGroup.make("workspace")
  .add(
    HttpApiEndpoint.get("query", "/workspaces", {
      query: Schema.Struct({
        ...WorkspaceFilter.fields,
        ...pageParams(WORKSPACE_SORT_FIELDS).fields,
      }),
      success: page(Workspace),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/workspaces/:id", {
      params: { id: Id },
      success: Workspace,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("provision", "/workspaces", {
      payload: WorkspaceProvisionInput,
      success: Workspace,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("dispose", "/workspaces/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
