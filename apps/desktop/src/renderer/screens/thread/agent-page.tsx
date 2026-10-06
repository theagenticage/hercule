/**
 * One agent's page on the thread, as the Bureau book's session page draws
 * it: the header floating over the transcript, and the composer floating
 * over its bottom. The agent is the session's own agent, or one of its
 * subagents. A subagent takes no messages, so its page has no composer.
 */
import { useRef, useState, type JSX } from "react";
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
  splitSubagentBrief,
} from "@hercule/client-core";
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
import { AgentRequestDock } from "./agent-request-dock";
import { BriefCard } from "../subagents/brief-card";
import { SpawnLines } from "../subagents/spawn-lines";
import { StatusCard } from "../subagents/status-card";
import { TallyPill } from "../subagents/tally-pill";
import { buildSubagentFaceSeed } from "../subagents/subagent-face";
import { useAgentLive } from "./use-agent-live";
import "./thread.css";

/**
 * Renders the page of one agent of the thread `sessionId`: the session's own
 * agent when `subagentId` is undefined, else that subagent.
 *
 * - The session's own agent's page has the header, the transcript and the
 *   composer.
 * - A subagent's page has the header, the brief its parent gave it, its
 *   transcript, with faces seeded `<sessionId>:<subagentId>`, and its status
 *   card in the composer's place.
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
}: {
  readonly sessionId: string;
  /** The subagent whose page this is; undefined for the session's own agent. */
  readonly subagentId: string | undefined;
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
  const attachOpenParagraph = useAgentLive(live, queryClient, sessionId, subagentId, rows);
  // The transcript sizes its bottom padding from the composer's stack. The
  // stack is held as state, not a ref, because the composer mounts after the
  // transcript: its element exists only once the transcript's effects ran,
  // and the state change runs them again with it.
  const [composerStack, setComposerStack] = useState<HTMLDivElement | null>(null);
  const transcriptRef = useRef<TranscriptHandle>(null);
  // The composer shrinks while the reader is away from the bottom of the
  // transcript, unless the focus is in the composer.
  const [atBottom, setAtBottom] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const shrunk = !atBottom && !composerFocused;

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

  return (
    <>
      <ThreadHeader sessionId={sessionId} subagentId={subagentId} />
      <Transcript
        faceSeed={
          subagentId === undefined ? sessionId : buildSubagentFaceSeed(sessionId, subagentId)
        }
        blocks={blocks}
        lead={
          subagent === undefined ? undefined : (
            <BriefCard subagent={subagent} subagents={subagents} brief={brief} />
          )
        }
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
      {subagent === undefined ? (
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
            <div className="fold tally-fold">
              <TallyPill sessionId={sessionId} />
            </div>
            <AgentRequestDock sessionId={sessionId} pageSubagentId={subagent.id} />
            <StatusCard
              subagent={subagent}
              subagents={subagents}
              openRequests={session.openRequests}
            />
          </div>
        </div>
      )}
    </>
  );
}
