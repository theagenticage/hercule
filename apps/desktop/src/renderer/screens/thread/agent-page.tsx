/**
 * One agent's page on the thread, as the Bureau book's session page draws
 * it: the header floating over the transcript, and the composer floating
 * over its bottom. The agent is the session's own agent, or one of its
 * subagents. A subagent takes no messages, so its page has no composer.
 */
import { useRef, useState, type JSX, type ReactNode } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { notFound, useRouteContext } from "@tanstack/react-router";
import {
  buildSessionAgentState,
  buildSubagentAgentState,
  buildThreadBlocks,
  decideSubagentPose,
  decideThreadPose,
  describeAgent,
  isSubagentWaiting,
  queryKeys,
  splitSubagentBrief,
} from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import {
  providersQuery,
  runnersQuery,
  sessionQuery,
  subagentsQuery,
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
 * Fails with `notFound` when the session has no subagent `subagentId`.
 */
export function AgentPage({
  sessionId,
  subagentId,
  drawSubagentParts,
}:
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
    }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, live } = controller;
  const queryClient = useQueryClient();
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
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (subagentId !== undefined && subagent === undefined) throw notFound();
  const attachOpenParagraph = useSessionLive({
    live,
    queryClient,
    sessionId,
    subagentId,
    rowsKey: queryKeys.transcript(sessionId, subagentId),
    rows,
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

  const agent =
    subagent === undefined
      ? buildSessionAgentState(session)
      : buildSubagentAgentState(subagent, session);
  // On a subagent's page, the user message that opens the transcript is the
  // brief its parent gave it, drawn as the brief card rather than as a
  // message nobody typed.
  const { brief, blocks } =
    subagent === undefined
      ? { brief: undefined, blocks: buildThreadBlocks(rows, agent) }
      : splitSubagentBrief(buildThreadBlocks(rows, agent));
  const runner =
    session.runnerId === null ? undefined : runners.find((each) => each.id === session.runnerId);
  const instance = instances.find((each) => each.id === session.instanceId);
  const subagentParts =
    subagent === undefined || drawSubagentParts === undefined
      ? undefined
      : drawSubagentParts({ session, subagent, subagents, brief });

  return (
    <>
      {subagentParts === undefined ? <ThreadHeader sessionId={sessionId} /> : subagentParts.header}
      <Transcript
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
