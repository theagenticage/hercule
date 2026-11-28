import { MAX_SESSION_RUN_IDS, type Session } from "@hercule/contract";
import type { HerculeClient } from "./client";
import { readEveryPage } from "./read-every-page";

/**
 * Reads every session the agent steps of the runs `runIds` started, exited
 * ones included, in as many `session.query` calls as `MAX_SESSION_RUN_IDS` ids
 * per call needs, and every page of each call. Returns no sessions for no run
 * ids. Fails when a read fails.
 */
export const readRunSessions = async (
  client: HerculeClient,
  runIds: readonly string[],
): Promise<readonly Session[]> => {
  const sessions: Session[] = [];
  for (let start = 0; start < runIds.length; start += MAX_SESSION_RUN_IDS) {
    const chunk = runIds.slice(start, start + MAX_SESSION_RUN_IDS);
    const chunkSessions = await readEveryPage((page) =>
      client.session.query({ query: { runId: chunk, ...page } }),
    );
    // A loop, not `push(...chunkSessions)`: a run can have thousands of sessions,
    // and spreading that many arguments can overflow the call stack.
    for (const session of chunkSessions) sessions.push(session);
  }
  return sessions;
};
