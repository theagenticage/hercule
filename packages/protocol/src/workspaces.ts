/**
 * Workspaces on the wire: what the controller asks a machine to make or tear
 * down, what the machine reports back, and the git credential exchange that
 * runs while it does.
 *
 * Ids cross this boundary and paths do not, with one exception: adopting a
 * folder the user already has means naming it, so `path` rides the provisioning
 * frame and is never stored on the controller.
 *
 * A credential is asked for per request and answered for that request alone:
 * the machine holds no token, and the controller answers only when the remote
 * git is about to talk to is a checkout the asker already has.
 */
import { Schema } from "effect";

import { Fact, MAX_FACT_LENGTH, StorageId, Subdirectory } from "./primitives";
import { MAX_MESSAGE_LENGTH } from "./sessions";

const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/** The most checkouts one workspace holds; a multi-repo workspace is a handful. */
export const MAX_CHECKOUTS = 32;

/** The most branches a machine reports for one checkout. */
export const MAX_BRANCHES = 1024;

/** How a working copy was made: cloned in full, or a worktree off the cache. */
export const CheckoutForm = Schema.Literals(["clone", "worktree"]);

export type CheckoutForm = Schema.Schema.Type<typeof CheckoutForm>;

/**
 * The two kinds of working area: the resource's own long-lived checkout, shared
 * by whatever runs in it, and one made for a piece of work and thrown away.
 */
export const WorkspaceKind = Schema.Literals(["primary", "ephemeral"]);

export type WorkspaceKind = Schema.Schema.Type<typeof WorkspaceKind>;

/** One working copy the machine is asked to make. */
export const ProvisionCheckout = Schema.Struct({
  checkoutId: StorageId,
  resourceId: StorageId,
  /** The remote as the user wrote it, which is what git is given. */
  remote: Fact,
  /** The folder to adopt in place. Absent means clone a fresh one. */
  path: Schema.optionalKey(Schema.String.check(Schema.isLengthBetween(1, MAX_FACT_LENGTH))),
  /** Where under the workspace this copy goes; null puts it at the root. */
  subdirectory: Schema.NullOr(Subdirectory),
  /** The branch to create, for a worktree; null leaves the branch alone. */
  branch: Schema.NullOr(Fact),
  /** What that branch starts from; null means the resource's default branch. */
  baseBranch: Schema.NullOr(Fact),
  /** Run in the checkout once it stands; null runs nothing. */
  setupCommand: Schema.NullOr(Message),
  /** Whether the primary's `.workspaceinclude` is copied into this copy. */
  workspaceInclude: Schema.Boolean,
});

export type ProvisionCheckout = Schema.Schema.Type<typeof ProvisionCheckout>;

export const WorkspaceProvision = Schema.Struct({
  _tag: Schema.Literal("workspaceProvision"),
  workspaceId: StorageId,
  kind: WorkspaceKind,
  /** Empty makes a scratch workspace: a directory and no working copy at all. */
  checkouts: Schema.Array(ProvisionCheckout).check(Schema.isMaxLength(MAX_CHECKOUTS)),
});

export type WorkspaceProvision = Schema.Schema.Type<typeof WorkspaceProvision>;

export const WorkspaceDispose = Schema.Struct({
  _tag: Schema.Literal("workspaceDispose"),
  workspaceId: StorageId,
});

export type WorkspaceDispose = Schema.Schema.Type<typeof WorkspaceDispose>;

/** What one working copy turned out to be, once the machine has made it. */
export const CheckoutReport = Schema.Struct({
  checkoutId: StorageId,
  /** The branch checked out there now. */
  branch: Fact,
  branches: Schema.Array(Fact).check(Schema.isMaxLength(MAX_BRANCHES)),
  /** What `origin/HEAD` points at, or null where the machine could not read it. */
  defaultBranch: Schema.NullOr(Fact),
});

export type CheckoutReport = Schema.Schema.Type<typeof CheckoutReport>;

/**
 * Where a workspace stands, in the machine's own words. `deleted` answers a
 * dispose; the other two answer a provision.
 */
export const WorkspaceReport = Schema.Struct({
  _tag: Schema.Literal("workspaceReport"),
  workspaceId: StorageId,
  status: Schema.Literals(["ready", "failed", "deleted"]),
  checkouts: Schema.optionalKey(
    Schema.Array(CheckoutReport).check(Schema.isMaxLength(MAX_CHECKOUTS)),
  ),
  /** Why it failed, in words the user can act on. */
  message: Schema.optionalKey(Message),
  /** What was skipped without failing the workspace. */
  warnings: Schema.optionalKey(Schema.Array(Message).check(Schema.isMaxLength(MAX_CHECKOUTS))),
});

export type WorkspaceReport = Schema.Schema.Type<typeof WorkspaceReport>;

/**
 * A machine asking for the credential git is about to need, naming the remote
 * and who is asking. Exactly one asker: a session, by the token it was started
 * with, or the machine itself while it is provisioning that workspace. Two
 * members rather than one struct with two optional fields, so the controller
 * reads one asker and cannot reach for the other; a frame that carries both is
 * read as the session it claims to be, which is the stronger claim of the two.
 */
const asking = {
  _tag: Schema.Literal("credentialRequest"),
  requestId: Fact,
  /** `<host>/<owner>/<repo>`, as git named it; the controller canonicalises it. */
  remote: Fact,
} as const;

export const SessionCredentialRequest = Schema.Struct({ ...asking, sessionToken: Fact });

export const WorkspaceCredentialRequest = Schema.Struct({ ...asking, workspaceId: Fact });

export const CredentialRequest = Schema.Union([
  SessionCredentialRequest,
  WorkspaceCredentialRequest,
]);

export type CredentialRequest = Schema.Schema.Type<typeof CredentialRequest>;

/** Why no credential is coming, so the machine can let git fall through. */
export const CredentialRefusal = Schema.Literals(["unauthorized", "no_connection"]);

export type CredentialRefusal = Schema.Schema.Type<typeof CredentialRefusal>;

/**
 * The credential, for this request and no other. The git identity rides with it
 * so the commits a session makes are attributed to the account pushing them.
 */
export const CredentialAnswer = Schema.Struct({
  _tag: Schema.Literal("credentialAnswer"),
  requestId: Fact,
  token: Schema.optionalKey(Fact),
  username: Schema.optionalKey(Fact),
  name: Schema.optionalKey(Fact),
  email: Schema.optionalKey(Fact),
  error: Schema.optionalKey(CredentialRefusal),
});

export type CredentialAnswer = Schema.Schema.Type<typeof CredentialAnswer>;
