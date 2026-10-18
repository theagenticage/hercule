/**
 * Which Skill Library skills a session gets (spec 06 section 9.4, "Who gets
 * what"). This is the one function that decides it. The controller calls it
 * at every start, fork and resume, so a Thread started after the library
 * changed gets the library as it is then, while a running session keeps the
 * set it started with.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SessionSkill } from "@hercule/protocol";
import { skillRepository } from "./repository";

/**
 * Returns the skills a session gets, sorted by name:
 *
 * - a Thread (`agentId: null`) gets the current revision of every Skill. A
 *   Skill that has only a proposed revision has no current one and is left
 *   out;
 * - every other session, an assistant's or a workflow agent step's, gets
 *   none, so it stays isolated.
 *
 * The list never holds the built-in `hercule` skill, which the runner adds
 * itself.
 */
export const decideSessionSkills = (session: {
  readonly agentId: string | null;
}): Effect.Effect<ReadonlyArray<SessionSkill>, SqlError, SqlClient.SqlClient> =>
  session.agentId !== null
    ? Effect.succeed([])
    : Effect.flatMap(skillRepository, (skills) => skills.listCurrentRevisions());
