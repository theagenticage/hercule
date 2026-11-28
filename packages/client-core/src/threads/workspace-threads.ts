import { MAX_SESSION_WORKSPACE_IDS, type Session } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { readEveryPage } from "../read-every-page";

/**
 * Reads every Thread placed in one of `workspaceIds`, in as many
 * `session.query` calls as `MAX_SESSION_WORKSPACE_IDS` ids per call needs, and
 * every page of each call. `archived` keeps only archived Threads (`true`) or
 * only the ones that are not archived (`false`); left out, both are read.
 * Fails when a read fails.
 *
 * One call names at most `MAX_SESSION_WORKSPACE_IDS` ids, because the server
 * refuses a request line over 16 KiB.
 */
export const readWorkspaceThreads = async (
  client: HerculeClient,
  workspaceIds: readonly string[],
  { archived }: { readonly archived?: boolean } = {},
): Promise<readonly Session[]> => {
  const threads: Session[] = [];
  for (let start = 0; start < workspaceIds.length; start += MAX_SESSION_WORKSPACE_IDS) {
    const chunk = workspaceIds.slice(start, start + MAX_SESSION_WORKSPACE_IDS);
    threads.push(
      ...(await readEveryPage((page) =>
        client.session.query({
          query: {
            workspaceId: chunk,
            kind: "thread",
            ...(archived === undefined ? {} : { archived }),
            ...page,
          },
        }),
      )),
    );
  }
  return threads;
};
