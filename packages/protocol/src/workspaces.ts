/**
 * Workspaces on the wire: what the controller asks a machine to make or tear
 * down, what the machine reports back, and the git credential exchange that
 * runs while it does.
 *
 * Ids cross this boundary and paths do not. Where a working copy sits is the
 * machine's own business: the controller names the repository and the machine
 * decides where under its storage the clone or the worktree goes.
 *
 * A credential is asked for per request and answered for that request alone:
 * the machine holds no token, and the controller answers only when the remote
 * git is about to talk to is a checkout the asker already has.
 */
import { Schema } from "effect";

import { Fact, StorageId, Subdirectory } from "./primitives";
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
  /**
   * The branch checked out there now, or null where the machine could not read
   * one: a detached HEAD, or a git that would not answer. Null rather than a
   * word standing in for a branch, because the record carries what the machine
   * said and nothing else.
   */
  branch: Schema.NullOr(Fact),
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
 * The credential, for this request and no other: either one to use or a reason
 * there is none. Two members rather than one struct of optional fields, so a
 * reader cannot hold an answer that is both and cannot forget to check which it
 * is. The git identity does not ride here - it is the session's, told once at
 * start on `SessionStart.gitIdentity`, and a credential exchange is not the
 * place to settle who a commit is by.
 */
export const CredentialGranted = Schema.Struct({
  _tag: Schema.Literal("credentialAnswer"),
  requestId: Fact,
  token: Fact,
  username: Fact,
});

export type CredentialGranted = Schema.Schema.Type<typeof CredentialGranted>;

export const CredentialRefused = Schema.Struct({
  _tag: Schema.Literal("credentialAnswer"),
  requestId: Fact,
  error: CredentialRefusal,
});

export type CredentialRefused = Schema.Schema.Type<typeof CredentialRefused>;

export const CredentialAnswer = Schema.Union([CredentialGranted, CredentialRefused]);

export type CredentialAnswer = Schema.Schema.Type<typeof CredentialAnswer>;
