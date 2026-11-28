import { MAX_SESSION_RUN_IDS, type Session } from "@hercule/contract";
import type { HerculeClient } from "./client";
import { readEveryPage } from "./read-every-page";

/**
 * Reads every session the agent steps of the runs `runIds` started, exited
 * ones included, in as many `session.query` calls as `MAX_SESSION_RUN_IDS` ids
 * per call needs, and every page of each call. Returns no sessions for no run
 * ids. Fails when a read fails.
 *
 * One call names at most `MAX_SESSION_RUN_IDS` ids, because the server refuses
 * a request line over 16 KiB.
 */
export const readRunSessions = async (
  client: HerculeClient,
  runIds: readonly string[],
): Promise<readonly Session[]> => {
  const sessions: Session[] = [];
  for (let start = 0; start < runIds.length; start += MAX_SESSION_RUN_IDS) {
    const chunk = runIds.slice(start, start + MAX_SESSION_RUN_IDS);
    sessions.push(
      ...(await readEveryPage((page) =>
        client.session.query({ query: { runId: chunk, ...page } }),
      )),
    );
  }
  return sessions;
};
