/**
 * The one rule for when a session is unfinished (spec 19 section 4.2): only
 * unfinished sessions are put into overlap Discussions. The rule has two
 * forms that must agree: the SQL condition `UNFINISHED_SESSION_CONDITION`
 * and the predicate `becomesUnfinishedByResume`.
 */
import type { StoredSession } from "./repository";

/**
 * The SQL condition that holds for an unfinished session, for the row of
 * `sessions` aliased `s`:
 *
 * - a Thread (no Agent behind it) is unfinished until it is Done;
 * - an agent step's session (it has a run) is unfinished while its Run is
 *   `pending` or `running`;
 * - any other session of an Agent is unfinished until it exits.
 *
 * `becomesUnfinishedByResume` repeats the last two rows in TypeScript.
 */
export const UNFINISHED_SESSION_CONDITION = `(CASE
  WHEN s.agent_id IS NULL THEN s.done_at IS NULL
  WHEN s.run_id IS NOT NULL THEN EXISTS (
    SELECT 1 FROM runs r WHERE r.id = s.run_id AND r.status IN ('pending', 'running'))
  ELSE s.status <> 'exited'
END)`;

/**
 * Checks whether resuming an exited session makes it unfinished again. Only a
 * session of an Agent that is not an agent step's does: a Thread is unfinished
 * by its Done mark and a step's session by its Run, and a resume changes
 * neither. See `UNFINISHED_SESSION_CONDITION`, which holds the whole rule.
 */
export const becomesUnfinishedByResume = (
  session: Pick<StoredSession, "agentId" | "runId">,
): boolean => session.agentId !== null && session.runId === null;
