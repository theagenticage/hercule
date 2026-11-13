/**
 * The one way to read a live thread for drawing: the records of one agent of
 * a Thread, the blocks built from them, and the live stream that keeps them
 * current. The agent's page and the first moments of a new Thread both draw
 * from it.
 */
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { notFound, useRouteContext } from "@tanstack/react-router";
import {
  appendSendingMessages,
  buildSessionAgentState,
  buildSubagentAgentState,
  buildThreadBlocks,
  decideSubagentPose,
  decideThreadPose,
  describeAgent as describeAgentModel,
  isNotFound,
  isSubagentWaiting,
  queryKeys,
  splitQueuedInputs,
  splitSubagentBrief,
  type Pose,
  type ThreadBlock,
} from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import {
  forgetGoneThread,
  providerAccountsQuery,
  providersQuery,
  queuedInputsQuery,
  runnersQuery,
  sessionQuery,
  subagentsQuery,
  transcriptQuery,
} from "../../app/queries";
import { buildAgentFaceSeed } from "../subagents/subagent-face";
import { UNREADABLE_STREAM_MESSAGE } from "../session/unreadable-stream";
import { useSessionLive, type AttachOpenParagraph } from "../session/use-session-live";

/**
 * Returns the error that closes a transcript whose stream the app cannot read,
 * from the moment (an ISO time) the stream became unreadable. `RuntimeNote`
 * draws that time like the time of any other note.
 */
const buildUnreadableStreamBlock = (
  streamUnreadableAt: string,
): Extract<ThreadBlock, { readonly kind: "error" }> => ({
  kind: "error",
  key: "stream-unreadable",
  message: UNREADABLE_STREAM_MESSAGE,
  at: streamUnreadableAt,
});

/** What `useLiveThreadBlocks` returns: what a transcript draws, and the records it was built from. */
export interface LiveThreadBlocks {
  readonly session: Session;
  /** The subagent whose transcript this is. Undefined for the session's own agent. */
  readonly subagent: Subagent | undefined;
  /** All the subagents of the session. */
  readonly subagents: readonly Subagent[];
  /** The brief the subagent's parent gave it. Undefined for the session's own agent, and while the transcript does not hold it yet. */
  readonly brief: string | undefined;
  /** The agent's blocks in reading order, ending with the messages on their way in and an unreadable stream's error. */
  readonly blocks: readonly ThreadBlock[];
  readonly pose: Pose;
  /** The seed of the agent's face. */
  readonly faceSeed: string;
  /** Returns the start of an agent message's meta line for the model slug the message ran on. */
  readonly describeAgent: (model: string) => string;
  readonly attachOpenParagraph: AttachOpenParagraph;
  /** True when the transcript's read found that the thread no longer exists. */
  readonly isGone: boolean;
}

/**
 * Reads the thread `sessionId`'s agent, the session's own when `subagentId`
 * is undefined, else that subagent, and keeps it live: the stream and the
 * tap follow the agent while the calling component is mounted. Returns the
 * blocks and what a transcript needs to draw them.
 *
 * Suspends until the reads are loaded, so the caller sits under a Suspense
 * boundary or in a route whose loader has loaded them. Fails with `notFound`
 * when the session has no subagent `subagentId`.
 *
 * The caller is mounted for one agent: the live tail it keeps belongs to
 * `sessionId` and `subagentId`.
 */
export const useLiveThreadBlocks = (
  sessionId: string,
  subagentId: string | undefined,
): LiveThreadBlocks => {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, live } = controller;
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const transcript = useSuspenseQuery(transcriptQuery(client, sessionId, subagentId));
  const rows = transcript.data;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const subagent =
    subagentId === undefined ? undefined : subagents.find((each) => each.id === subagentId);
  // The subagent route's loader has checked that the subagent exists, and a
  // subagent record is never deleted, so this only guards the type. The
  // router acts on a thrown `notFound`, which is a plain descriptor rather
  // than an Error.
  // oxlint-disable-next-line typescript/only-throw-error
  if (subagentId !== undefined && subagent === undefined) throw notFound();
  // `agent` is built in this read's `select`. Query hands back the same
  // `agent` object while its value is equal, so a session update that changes
  // nothing it holds, such as Token Usage or the tool call count, keeps the
  // blocks' `select` below the same function, and Query does not build the
  // blocks again over the whole transcript. A `useMemo` on `session` would not
  // do this: every read of the session is a new object. The compiler caches
  // the blocks' `select` on `agent`, so a stable `agent` keeps it the same
  // function.
  const agent = useSuspenseQuery({
    ...sessionQuery(client, sessionId),
    select: (current) =>
      subagent === undefined
        ? buildSessionAgentState(current)
        : buildSubagentAgentState(subagent, current),
  }).data;
  // The blocks are built in this read's `select`, not from `rows` above.
  // Query compares the new blocks with the previous ones and returns each
  // block that is equal as the same object, so the memoized blocks skip it.
  // Building them in render would make every block new on each stored row.
  // `rows` is the same read without `select`, because `useSessionLive` needs
  // the rows themselves. Query compares by position in the list: when a block
  // appears or disappears earlier in the list (a waiting block once its
  // Request closes), the blocks after it draw once more.
  const threadBlocks = useSuspenseQuery({
    ...transcriptQuery(client, sessionId, subagentId),
    select: (transcriptRows) => buildThreadBlocks(transcriptRows, agent),
  }).data;
  // The messages on their way into the session, drawn from their queued
  // inputs, close the session's own transcript. A subagent takes no
  // messages, so it reads none. Not suspended: the composer reads the same
  // inputs, and the Office drawer's loader does not load them.
  const queued = useQuery({
    ...queuedInputsQuery(client, sessionId),
    enabled: subagentId === undefined,
  }).data;
  const { attachOpenParagraph, streamUnreadableAt } = useSessionLive({
    live,
    queryClient,
    sessionId,
    subagentId,
    rowsKey: queryKeys.transcript(sessionId, subagentId),
    rows,
    onGone: () => {
      void forgetGoneThread(queryClient, client, controller.threadCopies, sessionId);
    },
  });

  // On a subagent's page, the user message that opens the transcript is the
  // brief its parent gave it, drawn as the brief card rather than as a
  // message nobody typed.
  const { brief, blocks } =
    subagent === undefined
      ? {
          brief: undefined,
          blocks: appendSendingMessages(
            threadBlocks,
            splitQueuedInputs(session, queued ?? []).sending,
          ),
        }
      : splitSubagentBrief(threadBlocks);
  const runner =
    session.runnerId === null ? undefined : runners.find((each) => each.id === session.runnerId);
  const account = accounts.find((each) => each.id === session.providerAccountId);
  return {
    session,
    subagent,
    subagents,
    brief,
    blocks:
      streamUnreadableAt === undefined
        ? blocks
        : [...blocks, buildUnreadableStreamBlock(streamUnreadableAt)],
    pose:
      subagent === undefined
        ? decideThreadPose(session, runner)
        : decideSubagentPose(subagent.status, isSubagentWaiting(subagent, session.openRequests)),
    faceSeed: buildAgentFaceSeed(sessionId, subagentId),
    describeAgent: (model) => describeAgentModel(providers, account, session.harnessId, model),
    attachOpenParagraph,
    isGone: isNotFound(transcript.error),
  };
};
