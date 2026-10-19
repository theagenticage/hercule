/**
 * Keeps the saved copy of the thread that is open up to date: saves it when
 * the thread's page closes and when a turn ends, and deletes it when the
 * thread no longer exists. The copy is built from the query cache, and the
 * store that keeps it is `thread-copies.ts`.
 */
import { useEffect, useRef } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { isNotFound, queryKeys, type ThreadCopy } from "@hercule/client-core";
import type { Input, Session, SessionStatus, Subagent, TranscriptRow } from "@hercule/contract";
import type { SavedController } from "./context";
import { sessionQuery } from "./queries";

/**
 * Builds the thread's copy from what the query cache holds now, without
 * reading from the network. Returns undefined when the cache lacks one of the
 * thread's four reads (session, subagents, queued inputs, own transcript), so
 * a thread that is still opening is never saved half empty.
 *
 * The copy holds references to the cached values, not clones, so it costs
 * almost nothing to build. It also holds the transcript of every subagent
 * whose page was opened and is still cached.
 */
export const buildThreadCopy = (
  queryClient: QueryClient,
  sessionId: string,
): ThreadCopy | undefined => {
  const session = queryClient.getQueryData<Session>(queryKeys.session(sessionId));
  const subagents = queryClient.getQueryData<readonly Subagent[]>(queryKeys.subagents(sessionId));
  const queuedInputs = queryClient.getQueryData<readonly Input[]>(queryKeys.inputs(sessionId));
  const transcript = queryClient.getQueryData<readonly TranscriptRow[]>(
    queryKeys.transcript(sessionId),
  );
  if (
    session === undefined ||
    subagents === undefined ||
    queuedInputs === undefined ||
    transcript === undefined
  ) {
    return undefined;
  }

  // The session's own transcript has `null` as its third key part, so it is
  // skipped here; every other key under this prefix is a subagent's.
  const subagentTranscripts: Record<string, readonly TranscriptRow[]> = {};
  const transcriptPrefix = queryKeys.transcript(sessionId).slice(0, 2);
  for (const [key, rows] of queryClient.getQueriesData<readonly TranscriptRow[]>({
    queryKey: transcriptPrefix,
  })) {
    const subagentId = key[2];
    if (typeof subagentId === "string" && rows !== undefined) {
      subagentTranscripts[subagentId] = rows;
    }
  }
  return { session, subagents, queuedInputs, transcript, subagentTranscripts };
};

/**
 * Saves the thread's copy, or deletes it when the controller answered that the
 * thread does not exist. Does nothing more when the cache lacks a read (see
 * `buildThreadCopy`) or the user is signed out: a thread page that closes
 * because of Sign Out must not write a copy after the sign-out deleted them.
 */
const saveOrDeleteThreadCopy = (
  queryClient: QueryClient,
  { client, threadCopies }: Pick<SavedController, "client" | "threadCopies">,
  sessionId: string,
): void => {
  if (isNotFound(queryClient.getQueryState(queryKeys.session(sessionId))?.error)) {
    void threadCopies.delete(sessionId);
    return;
  }
  if (client.getToken() === null) return;
  const copy = buildThreadCopy(queryClient, sessionId);
  if (copy !== undefined) void threadCopies.save(copy);
};

/**
 * Selects the session's status. It is declared once, outside the hook, so the
 * query reuses its selection instead of running it again on every render.
 */
const selectStatus = (session: Session): SessionStatus => session.status;

/**
 * Saves the copy of thread `sessionId` when its page closes (the component
 * unmounts or the session id changes) and when a turn ends (the session's
 * status leaves `busy`). It saves nothing per stored row, so a streaming
 * thread costs no disk work. Where the thread no longer exists, it deletes
 * the copy instead.
 *
 * The store skips a save of values it already holds on disk (see
 * `ThreadCopies.save`), so this hook saves without checking for changes.
 *
 * Only the thread's own route calls it. The Office's drawer shows a thread
 * page outside that route and does not save copies.
 *
 * It lives in `app/` because it only wires the query cache to the store and
 * renders nothing, like `useSubagentsLive`. The status is read with `useQuery`
 * here, where it is used, so the thread's layout renders again only when the
 * status changes.
 */
export const useKeepThreadCopy = (
  controller: Pick<SavedController, "client" | "threadCopies">,
  queryClient: QueryClient,
  sessionId: string,
): void => {
  const { client, threadCopies } = controller;
  const status = useQuery({ ...sessionQuery(client, sessionId), select: selectStatus }).data;

  useEffect(
    () => () => {
      saveOrDeleteThreadCopy(queryClient, { client, threadCopies }, sessionId);
    },
    [queryClient, client, threadCopies, sessionId],
  );

  const previous = useRef<{
    readonly sessionId: string;
    readonly status: SessionStatus | undefined;
  }>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = { sessionId, status };
    // A change of session is not a turn ending: compare with the same thread.
    const turnEnded =
      before?.sessionId === sessionId &&
      before.status === "busy" &&
      status !== undefined &&
      status !== "busy";
    if (turnEnded) saveOrDeleteThreadCopy(queryClient, { client, threadCopies }, sessionId);
  }, [queryClient, client, threadCopies, sessionId, status]);
};
