/**
 * The thread surface: a centred 800px column of turns that streams live, with
 * the composer floating at the bottom (spec 14 §The thread surface).
 */
import { useLayoutEffect, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { buildSiblingTabs, buildTurns, type HerculeClient, type Live } from "@hercule/client-core";
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
  readonly client: HerculeClient;
  readonly live: Live;
  readonly sessionId: string;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();

  // When the session changes elsewhere, such as a queued input being
  // delivered or a turn finishing, this keeps the screen's copy of the
  // session current, and with it the composer's locked fields and the queued
  // list. It lives here rather than in the composer, because a new thread has
  // no session to watch.
  useLiveInvalidation(live, queryClient, "session");

  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId)).data;
  // The item the session is parked on shows `awaiting approval` in the
  // transcript instead of `running`.
  const turns = buildTurns(rows, session.openRequest?.itemId);
  const { followIfAtBottom, scrollToBottom } = useStickToBottom();
  const tailRef = useThreadLive(live, queryClient, sessionId, rows, followIfAtBottom);
  const lastIndex = turns.length - 1;

  // The queued list above the composer is the third way the column grows. The
  // other two, a new stream row and a tap flush, are covered by `rows` and
  // `useThreadLive` above. Reading the same cache that `QueuedInputs` reads
  // costs nothing extra and needs no prop passed down.
  const queuedCount = (useQuery(inputsQuery(client, sessionId)).data?.items ?? []).filter(
    (row) => row.status === "queued",
  ).length;

  // The header shows the thread's project and the other threads in its
  // workspace next to the title.
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  const project = projects.find((each) => each.id === session.projectId);

  // Runs after the DOM has updated with whatever just grew. A change in
  // `rows.length` or `queuedCount` triggers it, and `followIfAtBottom` decides
  // whether the growth should move the scroll position.
  useLayoutEffect(() => {
    followIfAtBottom();
    // A permission card docking above the composer takes space from the
    // column just like a queued row, so it also triggers a follow.
  }, [rows.length, queuedCount, session.openRequest?.requestId, followIfAtBottom]);

  return (
    <div className="flex flex-1 flex-col">
      <ThreadChrome
        crumb={project?.name}
        title={session.title}
        tabs={buildSiblingTabs({ workspace, sessions, activeSessionId: session.id })}
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
          // Only the last turn of a busy session can still be running.
          //
          // - An earlier turn with no `turn.completed` was abandoned by an
          //   interrupt.
          // - An unfinished last turn on an idle or exited session was
          //   abandoned by the runner.
          //
          // Neither is running, so both show as finished with no duration,
          // rather than as working since they were last updated.
          const isLive = session.status === "busy" && index === lastIndex && turn.duration === null;
          return (
            <Turn
              key={turn.turnId}
              turn={turn}
              live={isLive}
              // The tap buffer holds one item's text at a time, so only the
              // live last turn gets the live tail element.
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
                // A new request gets a new card, so the answered state of the
                // previous request is not carried over.
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
