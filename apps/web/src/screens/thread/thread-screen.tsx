/**
 * The thread surface: a centered 800px column of turns, streaming live, the
 * composer floating at the foot (spec 14 §The thread surface).
 */
import { useLayoutEffect, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { siblingTabs, turnsOf, type HydraClient, type Live } from "@hydra/client-core";
import { useLiveInvalidation } from "../../app/live-invalidation";
import {
  inputsQuery,
  projectsQuery,
  sessionQuery,
  sessionsQuery,
  transcriptQuery,
  workspacesQuery,
} from "../../app/queries";
import { Composer } from "../composer/composer";
import { PermissionCard } from "./permission-card";
import { QueuedInputs } from "./queued-inputs";
import { ChromeAction, NewThreadHere, ThreadChrome, ThreadColumn } from "./thread-chrome";
import { useStickToBottom } from "./use-stick-to-bottom";
import { useThreadLive } from "./use-thread-live";
import { Turn } from "./turn";

export function ThreadScreen({
  client,
  live,
  sessionId,
  timezone,
}: {
  readonly client: HydraClient;
  readonly live: Live;
  readonly sessionId: string;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();

  // A session that changed elsewhere - a queued input delivered, a turn
  // finishing - keeps this screen's read of it, the composer's locked fields
  // and the queued list below the card current. It lives here rather than in
  // the composer because a new thread has no session to watch.
  useLiveInvalidation(live, queryClient, "session");

  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId)).data;
  // The item the session is parked on reads `awaiting approval` in the
  // transcript, in place of `running`.
  const turns = turnsOf(rows, session.openRequest?.itemId);
  const { followIfAtBottom, scrollToBottom } = useStickToBottom();
  const tailRef = useThreadLive(live, queryClient, sessionId, rows, followIfAtBottom);
  const lastIndex = turns.length - 1;

  // The queued list above the composer is the transcript's third growth path
  // (the other two, a stream row and a tap flush, are covered by `rows` and
  // `useThreadLive` above); reading the same cache `QueuedInputs` reads below
  // costs nothing extra and needs no prop threading down to it.
  const queuedCount = (useQuery(inputsQuery(client, sessionId)).data?.items ?? []).filter(
    (row) => row.status === "queued",
  ).length;

  // What the chrome names beside the title: the project the thread belongs to,
  // and the other threads in its workspace. Read here rather than passed down,
  // because the chrome is where they are drawn.
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  const project = projects.find((each) => each.id === session.projectId);

  // Runs after the DOM already reflects whatever just grew - `rows.length` or
  // `queuedCount` changing is the signal, `followIfAtBottom` itself is what
  // decides whether that growth should move the scroll.
  useLayoutEffect(() => {
    followIfAtBottom();
    // A card docking above the composer takes room from the column the same
    // way a queued row does, so the tail follows it too.
  }, [rows.length, queuedCount, session.openRequest?.requestId, followIfAtBottom]);

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome
        crumb={project?.name}
        title={session.title}
        tabs={siblingTabs({ workspace, sessions, activeSessionId: session.id })}
        actions={
          <>
            {workspace === undefined ? null : (
              <NewThreadHere projectId={session.projectId} workspaceId={workspace.id} />
            )}
            <ChromeAction title="More (not built)" icon disabled>
              …
            </ChromeAction>
          </>
        }
      />
      <ThreadColumn className="gap-6">
        {turns.map((turn, index) => {
          // Only the last turn of a busy session can still be running: an
          // earlier one with no `turn.completed` was abandoned by an interrupt,
          // and a dangling last turn on a session that is idle or exited was
          // abandoned by the runner - neither is still running, so both read as
          // settled with nothing to time rather than as working since whenever
          // they were last touched.
          const isLive = session.status === "busy" && index === lastIndex && turn.duration === null;
          return (
            <Turn
              key={turn.turnId}
              turn={turn}
              live={isLive}
              // The tap buffer holds one item's text at a time, so only the
              // live last turn gets the live node.
              tailRef={isLive ? tailRef : undefined}
              timezone={timezone}
            />
          );
        })}
        <div className="sticky bottom-0 mt-auto flex flex-col gap-2">
          <QueuedInputs client={client} sessionId={sessionId} />
          <div className="flex flex-col">
            {session.openRequest === null ? null : (
              <PermissionCard
                // A new request is a new card: the answered state of the one
                // before it is not carried over.
                key={session.openRequest.requestId}
                client={client}
                sessionId={sessionId}
                request={session.openRequest}
              />
            )}
            <Composer thread={{ kind: "active", session }} onSend={scrollToBottom} />
          </div>
        </div>
      </ThreadColumn>
    </div>
  );
}
