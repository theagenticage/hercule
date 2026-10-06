/**
 * One agent's page on the thread surface: a centred 800px column of the
 * agent's turns that streams live. The agent is the session's own agent, or
 * one of its subagents.
 *
 * - The session's own agent has the composer floating at the bottom.
 * - A subagent takes no messages, so its page opens with the brief its
 *   parent gave it and has a status card in the composer's place.
 *
 * An assistant's session uses the thread's page with two changes: the crumb
 * links back to the assistant's conversation, and a card pointing to that
 * conversation takes the composer's place, because the user talks to an
 * assistant in its conversation. A step session's crumb links to the run
 * that started it. Spec 14 §The thread surface owns the layout.
 */
import { useLayoutEffect, type JSX } from "react";
import { notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildSessionAgentState,
  buildSubagentAgentState,
  buildTurns,
  chooseStamps,
  findAnsweredAssistantId,
  type HerculeClient,
  type Live,
} from "@hercule/client-core";
import { inputsQuery, sessionQuery, subagentsQuery, transcriptQuery } from "../../app/queries";
import { Composer } from "../composer/composer";
import { ContentColumn } from "../content-column";
import { BriefCard } from "../subagents/brief-card";
import { StatusCard } from "../subagents/status-card";
import { TallyPill } from "../subagents/tally-pill";
import { useStickToBottom } from "../use-stick-to-bottom";
import { ConversationSessionNotice } from "./conversation-session-notice";
import { QueuedInputs } from "./queued-inputs";
import { RequestDock } from "./request-dock";
import { AgentChrome } from "./thread-chrome";
import { Turn } from "./turn";
import { useAgentLive } from "./use-agent-live";

export function AgentPage({
  client,
  live,
  sessionId,
  subagentId,
  timezone,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  readonly sessionId: string;
  /** The subagent whose page this is; undefined for the session's own agent. */
  readonly subagentId: string | undefined;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();

  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId, subagentId)).data;
  const subagent =
    subagentId === undefined ? undefined : subagents.find((each) => each.id === subagentId);
  // The route's loader has checked that the subagent exists, and a subagent
  // record is never deleted, so this only guards the type. The router acts on
  // a thrown `notFound`, which is a plain descriptor rather than an Error.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (subagentId !== undefined && subagent === undefined) throw notFound();
  // The agent's state: an item it is parked on shows `awaiting approval` in
  // the transcript instead of `running`, and it decides whether the last
  // turn may still be running.
  const agent =
    subagent === undefined
      ? buildSessionAgentState(session)
      : buildSubagentAgentState(subagent, session);
  const turns = buildTurns(rows, agent);
  const { followIfAtBottom, scrollToBottom } = useStickToBottom();
  const tailRef = useAgentLive(live, queryClient, sessionId, subagentId, rows, followIfAtBottom);
  const lastIndex = turns.length - 1;
  // Turns started in the same minute share one time separator.
  const stamps = chooseStamps(
    turns.map((turn) => turn.startedAt),
    timezone,
  );

  // The queued list above the composer is the third way the column grows. The
  // other two, a new stream row and a tap flush, are covered by `rows` and
  // `useAgentLive` above. Reading the same cache that `QueuedInputs` reads
  // costs nothing extra and needs no prop passed down. A subagent's page has
  // no queued list, so it reads nothing.
  const queuedCount = (
    useQuery({ ...inputsQuery(client, sessionId), enabled: subagent === undefined }).data?.items ??
    []
  ).filter((row) => row.status === "queued").length;

  const assistantId = findAnsweredAssistantId(session);
  const openRequestIds = session.openRequests.map((request) => request.requestId).join(" ");

  // Runs after the DOM has updated with whatever just grew. A change in
  // `rows.length` or `queuedCount` triggers it, and `followIfAtBottom` decides
  // whether the growth should move the scroll position. The user counts as at
  // the bottom until they scroll, so the first run opens the page on its
  // latest turn.
  useLayoutEffect(() => {
    followIfAtBottom();
    // A Request docking above the composer takes space from the column just
    // like a queued row, so a change in the open Requests also triggers a
    // follow.
  }, [rows.length, queuedCount, openRequestIds, followIfAtBottom]);

  return (
    <div className="flex flex-1 flex-col">
      <AgentChrome
        client={client}
        session={session}
        subagents={subagents}
        subagentId={subagentId}
      />
      <ContentColumn className="gap-6">
        {/* The turns take the height the composer leaves, so the composer
            stays at the foot of a short thread. Their bottom padding and the
            column gap leave 40px above the composer, as on an assistant's
            conversation. */}
        <div className="flex flex-1 flex-col gap-6 pb-4">
          {subagent === undefined ? null : (
            <BriefCard subagents={subagents} subagent={subagent} turns={turns} />
          )}
          {turns.map((turn, index) => {
            // Only the last turn can still be running.
            //
            // - An earlier turn with no `turn.completed` was abandoned by an
            //   interrupt.
            // - An unfinished last turn of an agent that cannot be running a
            //   turn was abandoned: its session runs no harness, or the
            //   subagent has ended. A session that reads `idle` has only not
            //   been read again since the turn started.
            //
            // Neither abandoned turn is running, so both show as finished
            // with no duration, rather than as working since they were last
            // updated.
            const isLive = agent.mayBeRunningTurn && index === lastIndex && turn.duration === null;
            return (
              <Turn
                key={turn.turnId}
                session={session}
                subagents={subagents}
                turn={turn}
                live={isLive}
                // The tap buffer holds one item's text at a time, so only the
                // live last turn gets the live tail element.
                tailRef={isLive ? tailRef : undefined}
                stamp={stamps[index]}
                // The brief card above already shows the brief, the user
                // message of a subagent's first turn.
                hidesUserMessage={subagent !== undefined && index === 0}
              />
            );
          })}
        </div>
        {/* The foot has the page's background, so the transcript scrolling
            beneath it never shows through beside the tally or between the
            cards. */}
        <div className="sticky bottom-0 flex flex-col gap-2 bg-bg">
          <TallyPill session={session} subagents={subagents} />
          {subagent === undefined ? <QueuedInputs client={client} sessionId={sessionId} /> : null}
          <div className="flex flex-col">
            <RequestDock
              client={client}
              session={session}
              subagents={subagents}
              subagentId={subagentId}
            />
            {subagent !== undefined ? (
              <StatusCard
                client={client}
                session={session}
                subagents={subagents}
                subagent={subagent}
              />
            ) : assistantId === null ? (
              <Composer thread={{ kind: "active", session }} onSend={scrollToBottom} />
            ) : (
              <ConversationSessionNotice
                client={client}
                sessionId={sessionId}
                assistantId={assistantId}
                busy={session.status === "busy"}
              />
            )}
          </div>
        </div>
      </ContentColumn>
    </div>
  );
}
