/**
 * One agent's page on the thread, as the Bureau book's session page draws
 * it: the header floating over the transcript, and the composer floating
 * over its bottom. The agent is the session's own agent, or one of its
 * subagents. A subagent takes no messages, so its page has no composer.
 */
import { useRef, useState, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { notFound, useRouteContext } from "@tanstack/react-router";
import {
  buildSessionAgentState,
  buildSubagentAgentState,
  buildThreadBlocks,
  decideSubagentPose,
  decideThreadPose,
  describeAgent,
  isSubagentWaiting,
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
import { useAgentLive } from "./use-agent-live";
import "./thread.css";

/**
 * Renders the page of one agent of the thread `sessionId`: the session's own
 * agent when `subagentId` is undefined, else that subagent.
 *
 * - The session's own agent's page has the header, the transcript and the
 *   composer.
 * - A subagent's page has the header and the subagent's transcript, with
 *   faces seeded `<sessionId>:<subagentId>`, and nothing in the composer's
 *   place.
 *
 * Mount it keyed by `<sessionId>/<subagentId>`, because the live tail it
 * keeps belongs to one agent. The Office's thread drawer mounts the
 * session's own agent's page outside the thread's route.
 *
 * Everything it reads is in the cache before it renders: the shell's loader
 * reads the providers and runners, the thread's loader the session and its
 * subagents, and each page's loader the agent's transcript. While it is
 * mounted, the agent's stream and tap keep the transcript and the tail
 * current.
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
  // Only a subagent's page reads the subagents. The Office's drawer draws
  // the session's own agent's page without the thread's loader, which is
  // what reads them, so a suspending read there would hold the drawer empty.
  const subagents = useQuery({
    ...subagentsQuery(client, sessionId),
    enabled: subagentId !== undefined,
  }).data;
  const subagent =
    subagentId === undefined ? undefined : subagents?.find((each) => each.id === subagentId);
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
  const blocks = buildThreadBlocks(rows, agent);
  const runner =
    session.runnerId === null ? undefined : runners.find((each) => each.id === session.runnerId);
  const instance = instances.find((each) => each.id === session.instanceId);

  return (
    <>
      <ThreadHeader sessionId={sessionId} />
      <Transcript
        faceSeed={subagentId === undefined ? sessionId : `${sessionId}:${subagentId}`}
        blocks={blocks}
        pose={
          subagent === undefined
            ? decideThreadPose(session, runner)
            : decideSubagentPose(subagent.status, isSubagentWaiting(subagent, session.openRequests))
        }
        describeAgent={(model) => describeAgent(instance, model)}
        attachOpenParagraph={attachOpenParagraph}
        composerStack={shrunk ? null : composerStack}
        onBottomChange={setAtBottom}
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
      ) : // The subagent's status slot: a subagent takes no messages, so the
      // composer's place is left empty. A card drawn here passes its element
      // to `setComposerStack`, so the transcript's last line clears it.
      null}
    </>
  );
}
