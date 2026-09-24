/**
 * Workspaces: the provisioned working areas on a machine that sessions do their
 * work in, and the checkouts inside them.
 *
 * A workspace is a kind and a list of checkouts; every git detail - the
 * branch, a subdirectory, how the copy was made - is stored on a checkout. A
 * primary workspace is the resource's own long-lived checkout on that machine,
 * shared by whatever runs in it and never torn down. An ephemeral one is made
 * for a piece of work and disposed of afterwards.
 *
 * The controller neither stores nor accepts a path. The machine decides where
 * the folder is: a primary workspace is always a Hercule-managed clone under
 * that machine's own storage.
 */
import { Schema } from "effect";
import { CheckoutForm, WorkspaceKind } from "@hercule/protocol";
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

/** The kinds and forms come from the runner protocol; the API returns them unchanged. */
export { CheckoutForm, WorkspaceKind };

/** The longest branch name; git's own limit is the filesystem's. */
export const MAX_BRANCH_LENGTH = 255;

/**
 * A branch name git accepts, validated here rather than on a machine. What a
 * caller writes is passed to `git checkout` and `git worktree add`, so a name
 * beginning with `-` would be read as an option. The other rules match what
 * `git check-ref-format` rejects:
 *
 * - `..` and `@{` have meanings of their own;
 * - a control character or a space cannot be part of a name;
 * - `~^:?*[\` are pattern and revision syntax;
 * - a trailing `/` or `.lock` is not a valid ref;
 * - a component beginning with `.`, such as `.hidden` or `refs/heads/.git`, is
 *   not a valid ref component.
 */
export const Branch = Schema.String.check(
  Schema.isLengthBetween(1, MAX_BRANCH_LENGTH),
  // The control characters are intended: git rejects them in a ref name, and
  // the name is validated here rather than by a git command that fails halfway.
  Schema.isPattern(
    // eslint-disable-next-line no-control-regex
    /^(?!.*(?:^|\/)[-.])(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)[^\u0000-\u0020~^:?*[\\\u007f]+$/,
    { title: "branch", description: "a git branch name" },
  ),
);

/**
 * The status of a workspace. `failed` and `lost` are both final: a `failed`
 * workspace could not be made, and a `lost` one was on a machine that was
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
  /**
   * The branch checked out there, as the machine reported it: null until the
   * machine reports one, and null when it could not read one. Not `Branch`,
   * which validates what a caller may ask for: this is a fact the machine
   * reports, and a record that rejected what the machine found would be
   * useless.
   */
  branch: Schema.NullOr(Schema.String),
  /** Every local branch the machine found, in its order. */
  branches: Schema.Array(Schema.String),
  defaultBranch: Schema.NullOr(Schema.String),
});

export type Checkout = Schema.Schema.Type<typeof Checkout>;

export const Workspace = Schema.Struct({
  id: Id,
  /** The machine the workspace was made on. A workspace never moves. */
  runnerId: Id,
  kind: WorkspaceKind,
  status: WorkspaceStatus,
  checkouts: Schema.Array(Checkout),
  /** The Connection of its first checkout's resource; null on a scratch workspace. */
  designatedConnectionId: Schema.NullOr(Id),
  /** The error message the machine reported when it could not make the workspace. */
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
 * The payload for provisioning a primary workspace: the resource's own checkout
 * on one machine. An ephemeral workspace is never provisioned on its own;
 * `session.spawn` makes it for the session that asked for it.
 */
export const WorkspaceProvisionInput = closedStruct({
  resourceId: Id,
  runnerId: Id,
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
