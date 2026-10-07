/**
 * Workspaces: the provisioned working areas on a machine that sessions do their
 * work in, and the checkouts inside them.
 *
 * A workspace is a kind and a list of checkouts; every git detail - the
 * branch, a subdirectory, how the copy was made - is stored on a checkout. A
 * primary workspace is the resource's own long-lived checkout on that machine,
 * shared by whatever runs in it. An ephemeral one is made for a piece of
 * work. Retention determines whether expiry may collect its managed files.
 *
 * Managed paths remain runner-local. Attachment accepts an explicit path
 * scoped to one runner, whose validation preserves the existing working copy.
 */
import { Schema } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  CheckoutForm,
  GitRemoteName,
  WorkspaceKind,
  WorkspaceOwnership,
  RepositoryMode,
  WorkspacePath,
  StartingRevision,
} from "@hercule/protocol";
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
export {
  CheckoutForm,
  GitRemoteName,
  WorkspaceKind,
  WorkspaceOwnership,
  RepositoryMode,
  WorkspacePath,
  StartingRevision,
};

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
 * Records preparation, availability and removal. `disposing` reserves removal
 * while the runner acts; `deleted` means the runner confirmed completion.
 * A failed attachment can recover after validating the same restored checkout.
 */
export const WORKSPACE_STATUSES = [
  "provisioning",
  "ready",
  "failed",
  "disposing",
  "deleted",
  "lost",
] as const;

export const WorkspaceStatus = Schema.Literals(WORKSPACE_STATUSES);

export type WorkspaceStatus = Schema.Schema.Type<typeof WorkspaceStatus>;

/** Chooses whether expiry may collect the workspace after its active holders leave. */
export const WorkspaceRetentionPolicy = Schema.Literals(["manual", "automatic"]);

export type WorkspaceRetentionPolicy = Schema.Schema.Type<typeof WorkspaceRetentionPolicy>;

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
  remoteBranches: Schema.Array(Schema.String),
  headCommit: Schema.NullOr(Schema.String),
  baseCommit: Schema.NullOr(Schema.String),
  startingRevision: Schema.NullOr(StartingRevision),
  /**
   * The branch this checkout's own branch was started from, as the caller
   * named it. Null when the caller named none, and the machine started it
   * from the resource's default branch; also null on a main workspace, which
   * starts no branch of its own.
   */
  baseBranch: Schema.NullOr(Schema.String),
});

export type Checkout = Schema.Schema.Type<typeof Checkout>;

export const Workspace = Schema.Struct({
  id: Id,
  /** The machine the workspace was made on. A workspace never moves. */
  runnerId: Id,
  kind: WorkspaceKind,
  status: WorkspaceStatus,
  ownership: WorkspaceOwnership,
  retentionPolicy: WorkspaceRetentionPolicy,
  /** The normalized attached root on the selected runner; null for managed storage. */
  path: Schema.NullOr(WorkspacePath),
  observedAt: Schema.NullOr(Timestamp),
  /** The runner's last observed derived workspaces; absent or null when their bindings are unknown. */
  derivedWorkspaceIds: Schema.optionalKey(Schema.NullOr(Schema.Array(Id))),
  warnings: Schema.Array(Schema.String),
  checkouts: Schema.Array(Checkout),
  /** The Connection of its first checkout's resource; null on a scratch workspace. */
  designatedConnectionId: Schema.NullOr(Id),
  /** The error message the machine reported when it could not make the workspace. */
  message: Schema.NullOr(Schema.String),
  /** The sessions working in it: each holds an active lease on it until it exits. */
  sessionIds: Schema.Array(Id),
  /**
   * When the sweep may collect an automatic workspace. Fixed when its last
   * holder releases it. Null for manual retention, a primary, a gone workspace
   * and while a session or run still holds it.
   */
  keptUntil: Schema.NullOr(Timestamp),
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

export const WorkspaceAttachInput = closedStruct({
  resourceId: Id,
  runnerId: Id,
  path: WorkspacePath,
  remoteName: Schema.optionalKey(GitRemoteName),
});

export type WorkspaceAttachInput = Schema.Schema.Type<typeof WorkspaceAttachInput>;

export const WorkspaceDisposeInput = closedStruct({
  discardChanges: Schema.optionalKey(Schema.Boolean),
});

export type WorkspaceDisposeInput = Schema.Schema.Type<typeof WorkspaceDisposeInput>;

/** Keeps bodyless deletion requests compatible with existing clients. */
const WorkspaceDisposeWithoutBody = Schema.Null.pipe(
  Schema.decodeTo(WorkspaceDisposeInput, {
    decode: SchemaGetter.transform(() => ({})),
    encode: SchemaGetter.transform(() => null),
  }),
);

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
    HttpApiEndpoint.post("attach", "/workspaces/attach", {
      payload: WorkspaceAttachInput,
      success: Workspace,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("inspect", "/workspaces/:id/inspect", {
      params: { id: Id },
      success: Workspace,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("dispose", "/workspaces/:id", {
      params: { id: Id },
      payload: [WorkspaceDisposeInput, WorkspaceDisposeWithoutBody],
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("detach", "/workspaces/:id/detach", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
