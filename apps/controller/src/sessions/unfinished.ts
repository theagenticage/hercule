/**
 * The one rule for when a session is unfinished (spec 19 section 4.2): only
 * unfinished sessions are put into overlap Discussions. It is written once,
 * as SQL, and read through `SessionRepository.isUnfinished` when TypeScript
 * needs the answer.
 */

/**
 * Returns the SQL condition that holds for an unfinished session, for the
 * row of `sessions` with the alias `alias`:
 *
 * - a Thread (no Agent behind it) is unfinished until it is Done;
 * - an agent step's session (it has a run) is unfinished while its Run is
 *   `pending` or `running`;
 * - any other session of an Agent is unfinished until it exits.
 */
export const buildUnfinishedClause = (alias: string): string => `(CASE
  WHEN ${alias}.agent_id IS NULL THEN ${alias}.done_at IS NULL
  WHEN ${alias}.run_id IS NOT NULL THEN EXISTS (
    SELECT 1 FROM runs r WHERE r.id = ${alias}.run_id AND r.status IN ('pending', 'running'))
  ELSE ${alias}.status <> 'exited'
END)`;
