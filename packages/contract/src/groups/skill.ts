/**
 * The Skill Library: the user's skills, kept by the controller and given to
 * every Thread on every runner (spec 11 section 2, `skill`).
 *
 * A Skill is a folder with a `SKILL.md` and the files beside it, named by a
 * name that is unique in the library. Each version of its files is a Skill
 * Revision, identified by the hash of its content. The Skill points at its
 * current revision, which sessions get, and at an available one when an update
 * check found an update that waits.
 *
 * `skill.import` carries one skill as one uncompressed tar archive in the
 * request body, as raw bytes, for the reason `attachment.create` gives: base64
 * in JSON would make a 10 MiB skill a third larger. The other inputs of an
 * import travel in the query string beside it.
 */
import { Schema } from "effect";
import { MAX_SKILLS, SkillFileMode, SkillName, SkillRevisionHash } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  CapExceeded,
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, NullableActor, Timestamp } from "../ids";
import { Authenticated } from "../security";

/**
 * Re-exported from the protocol, where the runner reads them, so a client that
 * builds an archive and the runner that unpacks one use the same values.
 */
export {
  buildSkillArchive,
  computeSkillArchiveByteLength,
  convertToSkillFileMode,
  MAX_SKILL_BYTES,
  MAX_SKILLS,
  SkillName,
  SkillPathTooLong,
  SkillRevisionHash,
  type SkillFile,
} from "@hercule/protocol";

/**
 * The name of the built-in skill every runner adds itself. It is not in the
 * Skill Library, so no Skill may take its name.
 */
export const BUILT_IN_SKILL_NAME = "hercule";

/** The most files one skill holds, a content rule the controller checks on every skill. */
export const MAX_SKILL_FILES = 1000;

/**
 * The refusal of `skill.import` for a session. A session that could import
 * would change what every future Thread loads without the user seeing it.
 * There is no `skill.propose` yet, so the refusal asks the user to import.
 * The controller fails with it, and the CLI's `skill import` row prints it as
 * the meaning of `forbidden`.
 */
export const ONLY_THE_USER_IMPORTS_SKILLS =
  "Only the user imports skills, so a session token is refused whatever grants its profile holds. Ask the user to import the skill.";

/**
 * The longest `sourceRepo`, `sourcePath` or `sourceBranch` an import takes.
 * GitHub's own limits are lower; the bound is only there so the stored value
 * cannot grow without limit.
 */
const MAX_SKILL_SOURCE_FIELD_LENGTH = 1024;

/**
 * Where a Skill comes from:
 *
 * - `github`: a folder of a public GitHub repository, which an update check
 *   reads. `repo` is `owner/name`, `path` the folder inside it, and `branch`
 *   is null for the repository's default branch.
 * - `upload`: the user's own files, which change only when the user imports a
 *   new version.
 */
export const SkillSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    repo: Schema.String,
    path: Schema.String,
    branch: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("upload") }),
]);

export type SkillSource = Schema.Schema.Type<typeof SkillSource>;

/**
 * The two `SKILL.md` frontmatter fields that change approvals on Claude Code:
 *
 * - `allowedTools`: the text of `allowed-tools`, or null.
 * - `hooks`: the value of `hooks` as canonical JSON (keys sorted, no spaces),
 *   or null.
 *
 * `hooks` holds the value rather than a flag, so two revisions' effects
 * compare as text: a changed hook counts as a change even when both revisions
 * have hooks.
 */
export const SkillApprovalEffects = Schema.Struct({
  allowedTools: Schema.NullOr(Schema.String),
  hooks: Schema.NullOr(Schema.String),
});

export type SkillApprovalEffects = Schema.Schema.Type<typeof SkillApprovalEffects>;

/**
 * One Skill, as every operation of the group returns it: the Skill joined with
 * what a list shows of its current and available revisions. Every `current`
 * field is null for a Skill that exists only as proposed revisions.
 */
export const Skill = Schema.Struct({
  name: Schema.String,
  source: SkillSource,
  /** The revision sessions get. */
  currentRevisionHash: Schema.NullOr(SkillRevisionHash),
  currentApprovalEffects: Schema.NullOr(SkillApprovalEffects),
  currentFileCount: Schema.NullOr(Schema.Int),
  /** The total bytes of the current revision's file contents. */
  currentSizeBytes: Schema.NullOr(Schema.Int),
  /** The revision an update check found and nobody has applied yet. */
  availableRevisionHash: Schema.NullOr(SkillRevisionHash),
  /**
   * Compared with `currentApprovalEffects`, so a list can say that an update
   * may change approvals before anyone applies it.
   */
  availableApprovalEffects: Schema.NullOr(SkillApprovalEffects),
  /** How many proposed revisions wait for review. */
  proposedCount: Schema.Int,
  /** When the last update check ended. Always null for an `upload` source. */
  lastCheckedAt: Schema.NullOr(Timestamp),
  /** The last update check's error message, or null when it succeeded. */
  checkError: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  createdBy: Actor,
  updatedAt: Timestamp,
  updatedBy: Actor,
});

export type Skill = Schema.Schema.Type<typeof Skill>;

/**
 * How a Skill Revision arrived:
 *
 * - `import`: read from a folder and sent with `skill.import`.
 * - `github`: an update check found it.
 * - `session`: a session proposed it.
 */
export const SkillRevisionOrigin = Schema.Literals(["import", "github", "session"]);

export type SkillRevisionOrigin = Schema.Schema.Type<typeof SkillRevisionOrigin>;

/** One immutable version of a Skill's files. */
export const SkillRevision = Schema.Struct({
  revisionHash: SkillRevisionHash,
  origin: SkillRevisionOrigin,
  fileCount: Schema.Int,
  /** The total bytes of its files' content, not the size of the archive that carried them. */
  sizeBytes: Schema.Int,
  /** The `description` in its `SKILL.md` frontmatter. */
  description: Schema.String,
  createdAt: Timestamp,
  /** `system` for a revision an update check stored. */
  createdBy: Actor,
  /** The last time the revision was made current, or null if it never was. */
  appliedAt: Schema.NullOr(Timestamp),
  appliedBy: NullableActor,
  /** True when a session that had read third-party messages proposed it. */
  includesThirdPartyContent: Schema.Boolean,
});

export type SkillRevision = Schema.Schema.Type<typeof SkillRevision>;

/** One file of a Skill Revision, without its content. */
export const SkillFileRecord = Schema.Struct({
  /** Relative to the skill's root, with `/` between folders. */
  path: Schema.String,
  mode: SkillFileMode,
  sizeBytes: Schema.Int,
});

export type SkillFileRecord = Schema.Schema.Type<typeof SkillFileRecord>;

/** What `skill.read` returns. */
export const SkillDetail = Schema.Struct({
  skill: Skill,
  /** The current revision's files, sorted by path. Empty when there is no current revision. */
  files: Schema.Array(SkillFileRecord),
  /** The text of the current revision's `SKILL.md`, or null when there is no current revision. */
  skillMd: Schema.NullOr(Schema.String),
  /** Every revision that has been current, each once, newest `appliedAt` first. */
  history: Schema.Array(SkillRevision),
  availableRevision: Schema.NullOr(SkillRevision),
  /** The proposed revisions, newest first. */
  proposedRevisions: Schema.Array(SkillRevision),
});

export type SkillDetail = Schema.Schema.Type<typeof SkillDetail>;

/**
 * What `skill.import` did:
 *
 * - `created`: no Skill had the name, so the content is a new Skill's current revision.
 * - `revised`: the content became the Skill's current revision.
 * - `unchanged`: the content was already current, so nothing was stored.
 */
export const SkillImportResult = Schema.Struct({
  result: Schema.Literals(["created", "revised", "unchanged"]),
  skill: Skill,
});

export type SkillImportResult = Schema.Schema.Type<typeof SkillImportResult>;

/**
 * Refuses `..`, `?`, `#` and control characters in a source path or branch.
 * The update check puts both into GitHub URLs, where each of those would
 * change which URL is read.
 */
const refuseUnsafeUrlText = (field: string) =>
  Schema.makeFilter((text: string) =>
    /\.\.|[?#]|\p{Cc}/u.test(text)
      ? `${field} may not hold \`..\`, \`?\`, \`#\` or a control character, because the update check puts it into a GitHub URL.`
      : undefined,
  );

/**
 * The inputs of `skill.import` other than the archive, carried in the query
 * string. `sourceRepo` and `sourcePath` together give a GitHub source, with
 * `sourceBranch` as its branch; none of the three gives an `upload` source.
 * `replace: true` lets the content replace a current revision that differs.
 *
 * `name` is any text here: the controller checks it with the content rules,
 * so a bad name is listed beside every other issue the content has.
 */
export const SkillImportInput = Schema.Struct({
  name: Schema.String,
  replace: Schema.optionalKey(Schema.Boolean),
  sourceRepo: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(MAX_SKILL_SOURCE_FIELD_LENGTH),
      Schema.isPattern(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, {
        expected: "a GitHub repository written owner/name",
      }),
    ),
  ),
  sourcePath: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(MAX_SKILL_SOURCE_FIELD_LENGTH),
      refuseUnsafeUrlText("sourcePath"),
    ),
  ),
  sourceBranch: Schema.optionalKey(
    Schema.String.check(
      Schema.isLengthBetween(1, MAX_SKILL_SOURCE_FIELD_LENGTH),
      refuseUnsafeUrlText("sourceBranch"),
    ),
  ),
}).check(
  Schema.makeFilter((input) => {
    if ((input.sourceRepo === undefined) !== (input.sourcePath === undefined))
      return "Give sourceRepo and sourcePath together for a GitHub source, or neither for an uploaded skill.";
    if (input.sourceBranch !== undefined && input.sourceRepo === undefined)
      return "sourceBranch is the branch of a GitHub source, so it needs sourceRepo and sourcePath too.";
    return undefined;
  }),
);

export type SkillImportInput = Schema.Schema.Type<typeof SkillImportInput>;

/**
 * What `skill.check` checks: one Skill, or every Skill with a GitHub source
 * when `name` is absent.
 */
export const SkillCheckInput = Schema.Struct({ name: Schema.optionalKey(SkillName) });

export type SkillCheckInput = Schema.Schema.Type<typeof SkillCheckInput>;

/**
 * How a file of a revision differs from the same path in the current
 * revision:
 *
 * - `added`: only the revision has it.
 * - `removed`: only the current revision has it.
 * - `modified`: both have it, with different content.
 * - `modeChanged`: both have it, with the same content and a different mode.
 */
export const SkillFileChangeKind = Schema.Literals(["added", "removed", "modified", "modeChanged"]);

export type SkillFileChangeKind = Schema.Schema.Type<typeof SkillFileChangeKind>;

/** One file a revision changes, as `skill.diff` returns it. */
export const SkillFileChange = Schema.Struct({
  /** Relative to the skill's root, with `/` between folders. */
  path: Schema.String,
  change: SkillFileChangeKind,
  /** The file's mode in the revision, or null for a removed file. */
  mode: Schema.NullOr(SkillFileMode),
  /**
   * The unified diff's hunks, without file headers: the whole text for an
   * added file, and empty for a file whose mode alone changed. Null when
   * `patchOmitted` says why it is left out.
   */
  patch: Schema.NullOr(Schema.String),
  /**
   * Why `patch` is null, or null when it is given:
   *
   * - `binary`: either side is not text.
   * - `tooLarge`: either side is over 1 MiB, or the patch would bring the
   *   patches before it, in path order, past 1 MiB in total.
   */
  patchOmitted: Schema.NullOr(Schema.Literals(["binary", "tooLarge"])),
});

export type SkillFileChange = Schema.Schema.Type<typeof SkillFileChange>;

/** What `skill.diff` returns: what a waiting revision would change, compared with the current one. */
export const SkillRevisionDiff = Schema.Struct({
  /** The revision's own approval effects, so a client can warn when `SKILL.md` did not change. */
  approvalEffects: SkillApprovalEffects,
  /** One entry per file that differs, sorted by path. */
  files: Schema.Array(SkillFileChange),
});

export type SkillRevisionDiff = Schema.Schema.Type<typeof SkillRevisionDiff>;

/** One Skill and the available revision the caller showed the user, for `skill.applyUpdates`. */
export const SkillUpdate = Schema.Struct({ name: SkillName, revisionHash: SkillRevisionHash });

export type SkillUpdate = Schema.Schema.Type<typeof SkillUpdate>;

/**
 * The updates "Update all" confirmed. Each Skill appears at most once, so a
 * repeated name is refused rather than read as a stale update.
 */
export const SkillApplyUpdatesInput = Schema.Struct({
  updates: Schema.Array(SkillUpdate).check(
    Schema.isMaxLength(MAX_SKILLS),
    Schema.makeFilter((updates) => {
      const names = updates.map((update) => update.name);
      const repeated = names.find((name, index) => names.indexOf(name) !== index);
      return repeated === undefined
        ? undefined
        : `\`${repeated}\` appears twice in updates; name each skill once.`;
    }),
  ),
});

export type SkillApplyUpdatesInput = Schema.Schema.Type<typeof SkillApplyUpdatesInput>;

/** The bytes of one skill's tar archive, as the request body carries them. */
const SkillArchiveBytes = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array());

const params = { name: SkillName };
const revisionParams = { name: SkillName, revisionHash: SkillRevisionHash };

export const skill = HttpApiGroup.make("skill")
  .add(
    // The whole library, sorted by name. It is short, so it is not paged.
    HttpApiEndpoint.get("query", "/skills", {
      success: Schema.Struct({ items: Schema.Array(Skill) }),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("read", "/skills/:name", {
      params,
      success: SkillDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // A body over `MAX_SKILL_BYTES` gets a bare `413` from the transport.
    //
    // - `forbidden`: the caller is a session; only the user imports.
    // - `validation`: the query is invalid, or the archive breaks a content
    //   rule, with every broken rule listed at once.
    // - `conflict`: the Skill exists with other content and `replace` is not
    //   `true`.
    // - `cap_exceeded`: a new name, and the library already holds
    //   `MAX_SKILLS`.
    //
    // The answer is `200` whatever `result` is: a `created` import is told
    // apart by its `result`, not by its status.
    HttpApiEndpoint.post("import", "/skills/import", {
      query: SkillImportInput,
      payload: SkillArchiveBytes,
      success: SkillImportResult,
      error: [Unauthenticated, Forbidden, Validation, Conflict, CapExceeded, Internal],
    }),
    // Deletes the Skill and every revision it has. A running session keeps
    // the copy its runner gave it.
    HttpApiEndpoint.delete("delete", "/skills/:name", {
      params,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // Starts an update check and answers at once; the check's result shows
    // in the Skill record once it ends.
    //
    // - `not_found`: no Skill has the name.
    // - `invalid_state`: the named Skill has no GitHub source.
    HttpApiEndpoint.post("check", "/skills/check", {
      payload: SkillCheckInput,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    // `not_found`: no Skill has the name, or no revision of it has the hash.
    HttpApiEndpoint.get("diff", "/skills/:name/revisions/:revisionHash/diff", {
      params: revisionParams,
      success: SkillRevisionDiff,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // - `not_found`: no Skill has the name, or no revision of it has the hash.
    // - `invalid_state`: the revision is neither available nor proposed, as
    //   the current revision and an earlier one are not.
    HttpApiEndpoint.post("apply", "/skills/:name/revisions/:revisionHash/apply", {
      params: revisionParams,
      success: Skill,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    // All or nothing, in one transaction.
    //
    // - `not_found`: no Skill has one of the names.
    // - `conflict`: a Skill's available revision is no longer the one named,
    //   because a check found a newer one; nothing is applied.
    HttpApiEndpoint.post("applyUpdates", "/skills/apply-updates", {
      payload: SkillApplyUpdatesInput,
      success: Schema.Struct({ items: Schema.Array(Skill) }),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
  )
  .middleware(Authenticated);
