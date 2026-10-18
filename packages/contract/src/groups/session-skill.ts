/**
 * The skills a session has: the library part and the repository part.
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
 * `sessionSkill`).
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { SkillName } from "@hercule/protocol";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id } from "../ids";
import { Authenticated } from "../security";
import { atMost } from "../strings";
import { MAX_SPAWN_CHECKOUTS } from "./session";

/**
 * One skill a session has. `source` says where it comes from:
 *
 * - `library`: a Skill of the Skill Library. `name` is the Skill's name, as
 *   the library spells it, such as `implement`.
 * - `repository`: a skill found in a checkout of the session's workspace.
 *   `name` is `<checkout>:<skill>`, where `<checkout>` is the folder of the
 *   checkout in the workspace and `<skill>` is the skill's folder name, such
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
    name: Schema.String,
    /** The `description` in the skill's `SKILL.md` frontmatter. */
    description: Schema.String,
    /**
     * The skill's folder, relative to its checkout, with `/` between folders,
     * such as `.agents/skills/release`.
     */
    path: Schema.String,
  }),
]);

export type SessionSkill = Schema.Schema.Type<typeof SessionSkill>;

/**
 * What `sessionSkill.query` returns.
 *
 * `items` lists the library skills first, then the repository skills, each
 * part sorted by name.
 *
 * `repositorySkillsUnavailable` is present when the repository part could not
 * be read, and holds the reason in plain words: the runner is offline, the
 * runner is too old to list skills, a repository has no main workspace on the
 * runner, or the runner failed. A client shows it, so a missing repository part
 * is never mistaken for an empty one. The library part is listed either way.
 */
export const SessionSkillList = Schema.Struct({
  items: Schema.Array(SessionSkill),
  repositorySkillsUnavailable: Schema.optionalKey(Schema.String),
});

export type SessionSkillList = Schema.Schema.Type<typeof SessionSkillList>;

/**
 * Asks for the skills of one of two things; any other combination is a
 * `validation` error.
 *
 * - `sessionId`: the skills of that session.
 * - `runnerId` with one or more `resourceId`: the skills a new Thread with
 *   those repos on that runner would get. A Draft Thread has no session yet,
 *   so the client sends what the draft knows. The library part is the Skills
 *   of the library as they are now, and the repository part is read from each
 *   repo's main workspace on that runner. Repeat `resourceId` for each repo:
 *   `?runnerId=<id>&resourceId=<id>&resourceId=<id>`.
 */
export const SessionSkillFilter = Schema.Struct({
  sessionId: Schema.optionalKey(Id),
  runnerId: Schema.optionalKey(Id),
  resourceId: Schema.optionalKey(atMost(Id, MAX_SPAWN_CHECKOUTS)),
}).check(
  Schema.makeFilter((filter) => {
    const hasDraftField = filter.runnerId !== undefined || filter.resourceId !== undefined;
    if (filter.sessionId !== undefined) {
      return hasDraftField
        ? "Send sessionId alone, or runnerId with one or more resourceId, not both."
        : undefined;
    }
    if (filter.runnerId !== undefined && (filter.resourceId?.length ?? 0) > 0) return undefined;
    return "Send sessionId for the skills of a session, or runnerId with one or more resourceId for the skills a new Thread would get.";
  }),
);

export type SessionSkillFilter = Schema.Schema.Type<typeof SessionSkillFilter>;

export const sessionSkill = HttpApiGroup.make("sessionSkill")
  .add(
    // Not paged: a session has few skills, and the composer needs the whole
    // list to offer them.
    //
    // - `not_found`: no session, runner or resource has the id given.
    HttpApiEndpoint.get("query", "/session-skills", {
      query: SessionSkillFilter,
      success: SessionSkillList,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
