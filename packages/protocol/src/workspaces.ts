/**
 * Workspaces on the wire: what the controller asks a machine to make or tear
 * down, what the machine reports back, and the git credential exchange that
 * runs while it does.
 *
 * Managed paths are resolved on the runner. Explicit attachment paths are
 * scoped to their named runner and are never sent to another machine.
 *
 * A credential is requested per operation and granted for that request only:
 * the machine holds no token, and the controller grants one only when the
 * remote git is about to use belongs to a checkout the requester already has.
 */
import { Schema } from "effect";

import { Fact, StorageId, Subdirectory, Timestamp } from "./primitives";
import { MAX_MESSAGE_LENGTH } from "./sessions";
import { MAX_REPOSITORY_SKILLS, MAX_SKIPPED_REASON_LENGTH, RepositorySkill } from "./skills";

const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/** The most checkouts one workspace holds; a multi-repo workspace is a handful. */
export const MAX_CHECKOUTS = 32;

/** The most branches a machine reports for one checkout. */
export const MAX_BRANCHES = 1024;

/** Negotiates attachment and the safe workspace lifecycle as one coherent feature. */
export const WORKSPACE_LIFECYCLE_CAPABILITY = "workspaceLifecycle";

/** Checks whether the negotiated capabilities support the selected-repository workspace lifecycle. */
export const supportsWorkspaceLifecycle = (capabilities: ReadonlyArray<string>): boolean =>
  capabilities.includes(WORKSPACE_LIFECYCLE_CAPABILITY);

/** An explicitly supplied absolute path on one supported runner. */
export const WorkspacePath = Schema.String.check(
  Schema.isLengthBetween(1, 4096),
  // eslint-disable-next-line no-control-regex
  Schema.isPattern(/^\/[^\u0000]*$/, { title: "workspace path", description: "an absolute path" }),
);

/** A configured Git remote name, passed to Git as an argument rather than shell text. */
export const GitRemoteName = Schema.String.check(
  Schema.isLengthBetween(1, 255),
  // eslint-disable-next-line no-control-regex
  Schema.isPattern(/^(?!-)[^\u0000-\u0020\u007f]+$/, { title: "Git remote name" }),
);

export const WorkspaceOwnership = Schema.Literals(["managed", "adopted"]);

export type WorkspaceOwnership = Schema.Schema.Type<typeof WorkspaceOwnership>;

/** Chooses the Git repository that supplies worktrees on one runner. */
export const RepositoryMode = Schema.Literals(["managed", "existing"]);

export type RepositoryMode = Schema.Schema.Type<typeof RepositoryMode>;

export const WorkspaceAttachment = Schema.Struct({
  path: WorkspacePath,
  remoteName: GitRemoteName,
});

export type WorkspaceAttachment = Schema.Schema.Type<typeof WorkspaceAttachment>;

/** Chooses committed state in the selected local repository without an implicit local fallback. */
export const StartingRevision = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("current") }),
  Schema.Struct({ kind: Schema.Literal("local"), branch: Fact }),
  Schema.Struct({ kind: Schema.Literal("remote"), branch: Schema.optionalKey(Fact) }),
]);

export type StartingRevision = Schema.Schema.Type<typeof StartingRevision>;

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
  /** Run in the checkout once it is ready; null runs nothing. */
  setupCommand: Schema.NullOr(Message),
  /** Whether the primary's `.workspaceinclude` is copied into this copy. */
  workspaceInclude: Schema.Boolean,
  /** The selected existing main workspace on this runner; absence never transfers another runner's path. */
  repositoryWorkspaceId: Schema.optionalKey(StorageId),
  startingRevision: Schema.optionalKey(StartingRevision),
});

export type ProvisionCheckout = Schema.Schema.Type<typeof ProvisionCheckout>;

export const WorkspaceProvision = Schema.Struct({
  _tag: Schema.Literal("workspaceProvision"),
  workspaceId: StorageId,
  kind: WorkspaceKind,
  attachment: Schema.optionalKey(WorkspaceAttachment),
  /** An empty list makes a scratch workspace: a directory with no working copy at all. */
  checkouts: Schema.Array(ProvisionCheckout).check(Schema.isMaxLength(MAX_CHECKOUTS)),
});

export type WorkspaceProvision = Schema.Schema.Type<typeof WorkspaceProvision>;

/** Checks whether provisioning requires the runner's selected-repository lifecycle support. */
export const requiresWorkspaceLifecycle = (frame: WorkspaceProvision): boolean =>
  frame.attachment !== undefined ||
  frame.checkouts.some(
    (checkout) =>
      checkout.repositoryWorkspaceId !== undefined ||
      checkout.startingRevision !== undefined ||
      checkout.baseBranch !== null,
  );

export const WorkspaceDispose = Schema.Struct({
  _tag: Schema.Literal("workspaceDispose"),
  workspaceId: StorageId,
  requestId: Schema.optionalKey(Fact),
  discardChanges: Schema.optionalKey(Schema.Boolean),
});

export type WorkspaceDispose = Schema.Schema.Type<typeof WorkspaceDispose>;

/** Forgets an attached registration without changing the checkout or its Git repository. */
export const WorkspaceDetach = Schema.Struct({
  _tag: Schema.Literal("workspaceDetach"),
  workspaceId: StorageId,
  requestId: Schema.optionalKey(Fact),
});

export type WorkspaceDetach = Schema.Schema.Type<typeof WorkspaceDetach>;

/** Removes managed files or forgets an existing checkout registration. */
export const WorkspaceRemoval = Schema.Union([WorkspaceDispose, WorkspaceDetach]);

export type WorkspaceRemoval = Schema.Schema.Type<typeof WorkspaceRemoval>;

/** The state of one working copy, once the machine has made it. */
export const CheckoutReport = Schema.Struct({
  checkoutId: StorageId,
  /**
   * The branch checked out there now, or null when the machine could not read
   * one: a detached HEAD, or a git command that failed. Null rather than a
   * placeholder word, because the record holds only what the machine
   * reported.
   */
  branch: Schema.NullOr(Fact),
  branches: Schema.Array(Fact).check(Schema.isMaxLength(MAX_BRANCHES)),
  /** What `origin/HEAD` points to, or null when the machine could not read it. */
  defaultBranch: Schema.NullOr(Fact),
  form: Schema.optionalKey(CheckoutForm),
  remoteBranches: Schema.optionalKey(Schema.Array(Fact).check(Schema.isMaxLength(MAX_BRANCHES))),
  headCommit: Schema.optionalKey(Schema.NullOr(Fact)),
  baseCommit: Schema.optionalKey(Schema.NullOr(Fact)),
  startingRevision: Schema.optionalKey(Schema.NullOr(StartingRevision)),
});

export type CheckoutReport = Schema.Schema.Type<typeof CheckoutReport>;

/**
 * The status of a workspace, as the machine reports it. `deleted` is the reply
 * to a dispose; the other two are replies to a provision.
 */
export const WorkspaceReport = Schema.Struct({
  _tag: Schema.Literal("workspaceReport"),
  workspaceId: StorageId,
  /** Correlates a removal outcome with its durable instruction. */
  requestId: Schema.optionalKey(Fact),
  status: Schema.Literals(["ready", "failed", "deleted"]),
  /** The normalized attached root, never an ordinary managed directory. */
  path: Schema.optionalKey(WorkspacePath),
  ownership: Schema.optionalKey(WorkspaceOwnership),
  /** The actual observation time; replay keeps the original receipt's time. */
  observedAt: Schema.optionalKey(Timestamp),
  /** The registered managed workspaces sharing this adopted checkout's recorded Git source. */
  derivedWorkspaceIds: Schema.optionalKey(Schema.NullOr(Schema.Array(StorageId))),
  /** Whether the recorded working files and Git binding exist, independent of preparation success. */
  available: Schema.optionalKey(Schema.Boolean),
  checkouts: Schema.optionalKey(
    Schema.Array(CheckoutReport).check(Schema.isMaxLength(MAX_CHECKOUTS)),
  ),
  /** Why it failed, in a message the user can act on. */
  message: Schema.optionalKey(Message),
  /** What was skipped without failing the workspace. */
  warnings: Schema.optionalKey(Schema.Array(Message).check(Schema.isMaxLength(MAX_CHECKOUTS))),
});

export type WorkspaceReport = Schema.Schema.Type<typeof WorkspaceReport>;

/** Requests current facts without fetching, running setup or changing the working files. */
export const WorkspaceInspect = Schema.Struct({
  _tag: Schema.Literal("workspaceInspect"),
  requestId: Fact,
  workspaceId: StorageId,
});

export type WorkspaceInspect = Schema.Schema.Type<typeof WorkspaceInspect>;

/** Correlates an inspection result with the request that produced it. */
export const WorkspaceInspection = Schema.Struct({
  _tag: Schema.Literal("workspaceInspection"),
  requestId: Fact,
  report: WorkspaceReport,
});

export type WorkspaceInspection = Schema.Schema.Type<typeof WorkspaceInspection>;

/**
 * Asks the runner to read the skills in the checkouts of one workspace: each
 * checkout's `.agents/skills` and `.claude/skills` folders. It changes nothing
 * on disk. Sent only to a runner that lists `REPOSITORY_SKILLS_CAPABILITY`.
 */
export const RepositorySkillsInspect = Schema.Struct({
  _tag: Schema.Literal("repositorySkillsInspect"),
  requestId: Fact,
  workspaceId: StorageId,
});

export type RepositorySkillsInspect = Schema.Schema.Type<typeof RepositorySkillsInspect>;

/**
 * One repo of a workspace that a Thread has not started yet: the checkout it
 * would get, and where the runner reads its skills from.
 */
export const RepositorySkillsPreviewCheckout = Schema.Struct({
  remote: Fact,
  /**
   * Where the checkout would sit in the workspace, which names its skills
   * (`formatCheckoutName`). Null when the checkout is the workspace root, as
   * with one repo; set when the workspace has two or more.
   */
  subdirectory: Schema.NullOr(Subdirectory),
  /**
   * The repo's ready main workspace on this runner, whose files the runner
   * reads. Null when the repo has none here: the checkout still reserves its
   * skill name, and the answer reports it as skipped.
   */
  workspaceId: Schema.NullOr(StorageId),
});

export type RepositorySkillsPreviewCheckout = Schema.Schema.Type<
  typeof RepositorySkillsPreviewCheckout
>;

/**
 * Asks the runner which skills a workspace would offer before it exists: the
 * runner lists the given checkouts the way it lists a real workspace, reading
 * each from the main workspace of its repo. It changes nothing on disk. The
 * runner answers with a `RepositorySkillsInspection` that has the same
 * `requestId` and no `workspaceId`. Sent only to a runner that lists
 * `REPOSITORY_SKILLS_CAPABILITY`.
 */
export const RepositorySkillsPreview = Schema.Struct({
  _tag: Schema.Literal("repositorySkillsPreview"),
  requestId: Fact,
  checkouts: Schema.Array(RepositorySkillsPreviewCheckout).check(
    Schema.isLengthBetween(1, MAX_CHECKOUTS),
  ),
});

export type RepositorySkillsPreview = Schema.Schema.Type<typeof RepositorySkillsPreview>;

/** A skill folder the runner found but cannot offer, and why. */
export const SkippedRepositorySkill = Schema.Struct({
  /**
   * The skipped folder relative to the workspace root, such as
   * `web/.agents/skills/My_Skill`, or `.agents/skills/My_Skill` for a
   * checkout at the root.
   */
  path: Fact,
  /** A plain-text message, at most `MAX_SKIPPED_REASON_LENGTH` characters. */
  reason: Schema.String.check(Schema.isMaxLength(MAX_SKIPPED_REASON_LENGTH)),
});

export type SkippedRepositorySkill = Schema.Schema.Type<typeof SkippedRepositorySkill>;

/**
 * Answers a `RepositorySkillsInspect` or a `RepositorySkillsPreview`, matched
 * by `requestId`.
 *
 * `skipped` names the skill folders and checkouts the runner found but cannot
 * offer, each with a reason. These are skipped:
 *
 * - a folder with an invalid name, no `SKILL.md`, or no valid description;
 * - a folder that is, or holds, a link to a place outside its checkout, or
 *   holds a second `SKILL.md`;
 * - a skills folder or checkout that cannot be read, and a repo with no ready
 *   main workspace on this runner (a preview);
 * - everything of a checkout whose skill prefix another checkout already has.
 *
 * Two kinds of entry are not listed in `skipped`: a plain file in a skills
 * folder, and a link to a file whose name is not a valid skill name. Neither
 * can be a skill, and a repository may hold any number of them.
 *
 * `truncated` is true when the runner stopped reading at `MAX_REPOSITORY_SKILLS`
 * skills or skipped entries, so either list may be missing entries. A client
 * must say so.
 *
 * `workspaceId` is the workspace an inspection asked about, and is absent from
 * the answer to a preview, which names no workspace.
 */
export const RepositorySkillsInspection = Schema.Struct({
  _tag: Schema.Literal("repositorySkillsInspection"),
  requestId: Fact,
  workspaceId: Schema.optionalKey(StorageId),
  outcome: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("listed"),
      skills: Schema.Array(RepositorySkill).check(Schema.isMaxLength(MAX_REPOSITORY_SKILLS)),
      skipped: Schema.Array(SkippedRepositorySkill).check(
        Schema.isMaxLength(MAX_REPOSITORY_SKILLS),
      ),
      truncated: Schema.Boolean,
    }),
    Schema.Struct({ status: Schema.Literal("failed"), message: Message }),
  ]),
});

export type RepositorySkillsInspection = Schema.Schema.Type<typeof RepositorySkillsInspection>;

/**
 * A machine's request for the credential git is about to need, with the remote
 * and who is asking. There is exactly one requester: a session, identified by
 * the token it was started with, or the machine itself while it provisions
 * that workspace. Two union members rather than one struct with two optional
 * fields, so the controller sees one requester and cannot use the other. A
 * frame that has both is treated as the session, which is the stronger claim.
 */
const asking = {
  _tag: Schema.Literal("credentialRequest"),
  requestId: Fact,
  /** `<host>/<owner>/<repo>`, as git gave it; the controller converts it to canonical form. */
  remote: Fact,
} as const;

export const SessionCredentialRequest = Schema.Struct({ ...asking, sessionToken: Fact });

export const WorkspaceCredentialRequest = Schema.Struct({ ...asking, workspaceId: Fact });

export const CredentialRequest = Schema.Union([
  SessionCredentialRequest,
  WorkspaceCredentialRequest,
]);

export type CredentialRequest = Schema.Schema.Type<typeof CredentialRequest>;

/** Why no credential is sent, so the machine can let git fall back to its other helpers. */
export const CredentialRefusal = Schema.Literals(["unauthorized", "no_connection"]);

export type CredentialRefusal = Schema.Schema.Type<typeof CredentialRefusal>;

/**
 * The reply to one credential request: either a credential to use, or the
 * reason there is none. Two union members rather than one struct of optional
 * fields, so a reply cannot be both and a reader cannot forget to check which
 * it is. The git identity is not included here: it belongs to the session and
 * is sent once, on `SessionStart.gitIdentity`. A credential exchange is not
 * the place to decide who a commit is by.
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
