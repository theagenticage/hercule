/**
 * The skills a session has: the library part and the repository part. Two
 * operations return them, `session.querySkills` for a session and
 * `session.previewSkills` for a new Thread.
 *
 * - The library part is the Skills of the Skill Library the controller decided
 *   to give the session when it started, forked or resumed. A Skill added to
 *   the library later is not on that session's disk, so it is not listed.
 * - The repository part is the skills found in the checkouts of the session's
 *   workspace, in each checkout's `.claude/skills` and `.agents/skills`. The
 *   controller reads it live from the runner, so it is the same for every
 *   harness.
 *
 * The composer lists both parts in its skill picker (spec 11 section 2,
 * `session.querySkills`).
 */
import { Schema } from "effect";
import { CheckoutName, SkillName } from "@hercule/protocol";

/**
 * The name of a repository skill: `<checkout>:<skill>`, such as
 * `hercule:release`. `<checkout>` is the checkout's normalized name, not its
 * folder: the folder name in lowercase, with every run of characters other
 * than letters and digits turned into one hyphen (`foo.js` gives `foo-js`).
 * `<skill>` is the skill's folder name. Each part follows the Agent Skills
 * name rule, as `SkillName` states it.
 */
export const RepositorySkillName = Schema.TemplateLiteral([CheckoutName, ":", SkillName]);

export type RepositorySkillName = Schema.Schema.Type<typeof RepositorySkillName>;

/**
 * One skill a session has. `source` says where it comes from:
 *
 * - `library`: a Skill of the Skill Library. `name` is the Skill's name, as
 *   the library spells it, such as `implement`.
 * - `repository`: a skill found in a checkout of the session's workspace.
 *   `name` is `<checkout>:<skill>`, as `RepositorySkillName` describes, such
 *   as `hercule:release`. The prefix keeps two checkouts that hold a skill of
 *   the same name apart. A library skill and a repository skill may share the
 *   part after the prefix; both are listed.
 */
export const SessionSkill = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("library"),
    name: SkillName,
    /** The `description` in the Skill's `SKILL.md` frontmatter. */
    description: Schema.String,
  }),
  Schema.Struct({
    source: Schema.Literal("repository"),
    name: RepositorySkillName,
    /** The `description` in the skill's `SKILL.md` frontmatter. */
    description: Schema.String,
    /**
     * The skill's folder relative to the workspace root, with `/` between
     * folders: `web/.agents/skills/release` for a checkout in the `web`
     * folder, `.agents/skills/release` for a checkout at the root.
     */
    path: Schema.String,
  }),
]);

export type SessionSkill = Schema.Schema.Type<typeof SessionSkill>;

/**
 * A skill folder in a checkout that is not offered as a skill, and why.
 * Without this list, a user whose skill is missing could only find out why in
 * the runner's log.
 */
export const SkippedSessionSkill = Schema.Struct({
  /** The folder relative to the workspace root, as `SessionSkill.path` is. */
  path: Schema.String,
  /** A plain-text message that says what is wrong with the folder. */
  reason: Schema.String,
});

export type SkippedSessionSkill = Schema.Schema.Type<typeof SkippedSessionSkill>;

/**
 * What `session.querySkills` and `session.previewSkills` return.
 *
 * - `items` lists the library skills first, then the repository skills, each
 *   part sorted by name.
 * - `skipped` lists the repository skill folders that are not offered, each
 *   with its reason.
 * - `incompleteReason` is present when `items` may not hold all the skills of
 *   the session, and holds the reason in plain words. A client shows it, so a
 *   missing part is never mistaken for an empty one. When both causes below
 *   apply, the two sentences are joined into one message.
 *   - The session started before the controller recorded its library skills,
 *     so its library part is not listed.
 *   - The repository part could not be read: the runner is offline, the runner
 *     is too old to list skills, a repository has no main workspace on the
 *     runner, or the runner failed. The library part is listed either way.
 */
export const SessionSkillList = Schema.Struct({
  items: Schema.Array(SessionSkill),
  skipped: Schema.Array(SkippedSessionSkill),
  incompleteReason: Schema.optionalKey(Schema.String),
});

export type SessionSkillList = Schema.Schema.Type<typeof SessionSkillList>;
