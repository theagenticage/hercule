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
 * - an agent step's session (it has a run) is unfinished while its Run is
 *   `pending` or `running`, so an idle unload between steps does not end it;
 * - any other session, a Thread included, is unfinished until it exits, and a
 *   Thread also stops being unfinished when it is marked Done.
 *
 * An exited Thread counts as finished because it cannot be told anything.
 * When it resumes it becomes unfinished again and meets the others then.
 */
export const buildUnfinishedClause = (alias: string): string => `(CASE
  WHEN ${alias}.run_id IS NOT NULL THEN EXISTS (
    SELECT 1 FROM runs r WHERE r.id = ${alias}.run_id AND r.status IN ('pending', 'running'))
  ELSE ${alias}.status <> 'exited' AND ${alias}.done_at IS NULL
END)`;
