/**
 * One agent's page on the thread, as the Bureau book's session page draws
 * it: the header floating over the transcript, and the composer floating
 * over its bottom. The agent is the session's own agent, or one of its
 * subagents. A subagent takes no messages, so its page has no composer.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Navigate, notFound, useLocation, useRouteContext } from "@tanstack/react-router";
import {
  appendSendingMessages,
  buildSessionAgentState,
  buildSubagentAgentState,
  buildThreadBlocks,
  decideSubagentPose,
  decideThreadPose,
  describeAgent,
  isNotFound,
  isSubagentWaiting,
  queryKeys,
  splitQueuedInputs,
  splitSubagentBrief,
} from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { isOpenedAtLaunch } from "../../app/last-screen";
import {
  forgetGoneThread,
  providersQuery,
  queuedInputsQuery,
  runnersQuery,
  sessionQuery,
  subagentsQuery,
  transcriptCatchUpQuery,
  transcriptQuery,
} from "../../app/queries";
import { ThreadComposer } from "./composer";
import { ThreadHeader } from "./thread-header";
import { Transcript, type TranscriptHandle } from "./transcript";
import { SpawnLines } from "../subagents/spawn-lines";
import { buildAgentFaceSeed } from "../subagents/subagent-face";
import { useSessionLive } from "../session/use-session-live";
import "../session/transcript.css";
import "./thread.css";

/** What a subagent's page draws of its own, from the records the page reads. */
export interface SubagentParts {
  /** Drawn in the thread header's place: the crumb down to the subagent. */
  readonly header: ReactNode;
  /** Drawn above the transcript's first block: the brief card. */
  readonly lead: ReactNode;
  /** Drawn in the composer's place: the status card and what sits on it. */
  readonly bottom: ReactNode;
}

/**
 * Returns what a subagent's page draws of its own, for `subagent`, given the
 * thread's session, its subagents, and the brief the subagent's parent gave
 * it (undefined while the transcript does not hold it yet).
 */
export type DrawSubagentParts = (records: {
  readonly session: Session;
  readonly subagent: Subagent;
  readonly subagents: readonly Subagent[];
  readonly brief: string | undefined;
}) => SubagentParts;

/**
 * Renders the page of one agent of the thread `sessionId`: the session's own
 * agent when `subagentId` is undefined, else that subagent.
 *
 * - The session's own agent's page has the header, the transcript and the
 *   composer.
 * - A subagent's page has its transcript, with faces seeded
 *   `<sessionId>:<subagentId>`, and the parts `drawSubagentParts` returns:
 *   its own header, the brief above the transcript and the status card in
 *   the composer's place. The subagent's page passes them in, so they load
 *   with that page rather than with the thread's.
 *
 * Under each work stretch that started subagents, the transcript draws
 * their spawn lines, which link to their pages.
 *
 * Mount it keyed by `<sessionId>/<subagentId>`, because the live tail it
 * keeps belongs to one agent. The Office's thread drawer mounts the
 * session's own agent's page outside the thread's route, where there is no
 * side pane, so the page leaves out the tally pill and the pane toggle.
 *
 * Everything it reads is in the cache before it renders: the shell's loader
 * reads the providers and runners, the thread's loader (or the Office's,
 * for the drawer) the session and its subagents, and each page's loader the
 * agent's transcript. While it is mounted, the agent's stream and tap keep
 * the transcript and the tail current.
 *
 * A thread that opened from its saved copy holds the copy's rows. The page
 * subscribes to the agent's topics only after `transcriptCatchUpQuery` has
 * merged the rows written since, or has failed (the stream then replays
 * them). When the catch-up finds that the thread no longer exists and the
 * page is in the thread's route (`inThreadRoute`), the page shows the
 * thread's not-found screen, or goes to the new-thread screen when the app
 * opened the thread at launch. Elsewhere, such as in the Office's drawer,
 * the page keeps showing what it holds: leaving a route that is not on
 * screen would throw `notFound` for the wrong route or navigate away from
 * the Office.
 *
 * Fails with `notFound` when the session has no subagent `subagentId`.
 */
export function AgentPage({
  sessionId,
  subagentId,
  drawSubagentParts,
  inThreadRoute,
}: {
  /** Whether the page is drawn by the thread's route, as opposed to the Office's drawer. */
  readonly inThreadRoute: boolean;
} & (
  | {
      readonly sessionId: string;
      readonly subagentId: undefined;
      readonly drawSubagentParts?: undefined;
    }
  | {
      readonly sessionId: string;
      /** The subagent whose page this is. */
      readonly subagentId: string;
      readonly drawSubagentParts: DrawSubagentParts;
    }
)): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, live } = controller;
  const queryClient = useQueryClient();
  // Only the flag is read, so a navigation does not draw the page again.
  const isAtLaunch = useLocation({ select: isOpenedAtLaunch });
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId, subagentId)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
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
  // messages, so its page reads none. Not suspended: the composer below
  // reads the same inputs, and the drawer's loader does not load them.
  const queued = useQuery({
    ...queuedInputsQuery(client, sessionId),
    enabled: subagentId === undefined,
  }).data;
  // A thread opened from its saved copy holds the copy's rows until this read
  // has merged the newer ones. The stream is subscribed after it, from the
  // newest row, so its replay stays small. A read that fails is no reason to
  // stay unsubscribed: the stream's replay then fills the gap from the rows
  // held. A thread read from the controller has this read done already.
  const catchUp = useQuery(transcriptCatchUpQuery(client, sessionId, subagentId));
  const catchUpError = catchUp.error;
  useEffect(() => {
    if (catchUpError !== null && !isNotFound(catchUpError)) {
      console.error("Could not bring the thread's saved transcript up to date:", catchUpError);
    }
  }, [catchUpError]);
  const attachOpenParagraph = useSessionLive({
    live: catchUp.isPending ? null : live,
    queryClient,
    sessionId,
    subagentId,
    rowsKey: queryKeys.transcript(sessionId, subagentId),
    rows,
    onGone: () => {
      void forgetGoneThread(queryClient, client, controller.threadCopies, sessionId);
    },
  });
  // The transcript sizes its bottom padding from the composer's stack. The
  // stack is held as state, not a ref, because the composer mounts after the
  // transcript: its element exists only once the transcript's effects ran,
  // and the state change runs them again with it.
  const [composerStack, setComposerStack] = useState<HTMLDivElement | null>(null);
  const transcriptRef = useRef<TranscriptHandle>(null);
  // The composer shrinks while the reader is away from the bottom of the
  // transcript, unless the focus is in the composer. A subagent's status
  // card never shrinks, so the transcript always clears it.
  const [atBottom, setAtBottom] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const shrunk = subagent === undefined && !atBottom && !composerFocused;

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
  if (inThreadRoute && isNotFound(catchUpError)) {
    // The catch-up found that the thread no longer exists, which the saved
    // copy could not know. Show what the thread's loader shows for it, see
    // `throwScreenNotFound`. A redirect cannot be thrown from a component.
    if (isAtLaunch) return <Navigate to="/" replace />;
    // The thread's own page has no not-found screen of its own, so the thread
    // route's shows. A subagent's route has one, which says the same.
    // oxlint-disable-next-line typescript/only-throw-error
    throw notFound(
      subagentId === undefined ? { routeId: "/_connected/_shell/threads/$sessionId" } : undefined,
    );
  }
  const runner =
    session.runnerId === null ? undefined : runners.find((each) => each.id === session.runnerId);
  const instance = instances.find((each) => each.id === session.instanceId);
  const subagentParts =
    subagent === undefined || drawSubagentParts === undefined
      ? undefined
      : drawSubagentParts({ session, subagent, subagents, brief });

  return (
    <>
      {subagentParts === undefined ? <ThreadHeader session={session} /> : subagentParts.header}
      <Transcript
        sessionId={sessionId}
        faceSeed={buildAgentFaceSeed(sessionId, subagentId)}
        blocks={blocks}
        lead={subagentParts?.lead}
        pose={
          subagent === undefined
            ? decideThreadPose(session, runner)
            : decideSubagentPose(subagent.status, isSubagentWaiting(subagent, session.openRequests))
        }
        describeAgent={(model) => describeAgent(instance, model)}
        attachOpenParagraph={attachOpenParagraph}
        composerStack={shrunk ? null : composerStack}
        onBottomChange={setAtBottom}
        renderSpawnLines={(items, onScreen) => (
          <SpawnLines
            sessionId={sessionId}
            agentSubagentId={subagentId}
            items={items}
            onScreen={onScreen}
          />
        )}
        ref={transcriptRef}
      />
      {subagentParts === undefined ? (
        <ThreadComposer
          sessionId={sessionId}
          shrunk={shrunk}
          onFocusChange={setComposerFocused}
          scrollTranscriptToBottom={() => {
            transcriptRef.current?.scrollToBottom();
          }}
          ref={setComposerStack}
        />
      ) : (
        // A subagent takes no messages, so its status card takes the
        // composer's place. The stack is passed to `setComposerStack`, so the
        // transcript's last line clears the card and what sits on it.
        <div className="composer-wrap">
          <div className="composer" ref={setComposerStack}>
            {subagentParts.bottom}
          </div>
        </div>
      )}
    </>
  );
}
