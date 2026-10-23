/**
 * Reads the lists behind the sessions the sidebar shows and prepares them
 * once (`prepareSessionPresentation`), for every part of the shell that shows
 * a session: the sidebar and its foot, Waiting on you (and with it the Go
 * menu, the dock badge and the notifications), and the routing of a
 * destination. They all read the one result, so they always agree on what
 * exists, and the preparation runs once for all of them.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMatch, useRouteContext } from "@tanstack/react-router";
import { prepareSessionPresentation, type SessionPresentation } from "@hercule/client-core";
import { useRelatedReads } from "./related-reads";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  threadAndAgentSessionsQuery,
  workspacesQuery,
} from "./queries";

const SessionPresentationContext = createContext<SessionPresentation | null>(null);

/** Holds a function that returns the latest presentation, which keeps its identity. */
const ReadSessionPresentationContext = createContext<(() => SessionPresentation) | null>(null);

/**
 * Returns the id of the session the user has open: the one on its own
 * screen, or the one in the Office's drawer, or `null` when none is open.
 */
export function useOpenSessionId(): string | null {
  // Each match is read through `select`, so a caller draws again only when the id changes.
  const threadId = useMatch({
    from: "/_connected/_shell/threads/$sessionId",
    shouldThrow: false,
    select: (match) => match.params.sessionId,
  });
  const officeId = useMatch({
    from: "/_connected/_shell/office",
    shouldThrow: false,
    select: (match) => match.search.session,
  });
  return threadId ?? officeId ?? null;
}

/**
 * Prepares the session presentation from the cached reads and offers it to
 * `children`, which read it with `useSessionPresentation`. It prepares again
 * only when one of the reads changes, not for a push that changes none.
 *
 * The open session's record is read from the cache the thread screen filled
 * and never fetched here, so this adds no read. The empty id of no open
 * session names no record.
 *
 * It also reads the projects, workspaces and resources again when a session
 * names one the cache does not hold (`useRelatedReads`).
 */
export function SessionPresentationProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const listedSessions = useSuspenseQuery(threadAndAgentSessionsQuery(client)).data;
  const openId = useOpenSessionId();
  const openSession =
    useQuery({ ...sessionQuery(client, openId ?? ""), enabled: false }).data ?? null;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const presentation = useMemo(
    () =>
      prepareSessionPresentation({
        listedSessions,
        openSession,
        projects,
        workspaces,
        resources,
        runners,
        instances,
      }),
    [listedSessions, openSession, projects, workspaces, resources, runners, instances],
  );
  useRelatedReads(presentation.sessions, projects, workspaces);
  const latest = useRef(presentation);
  useEffect(() => {
    latest.current = presentation;
  }, [presentation]);
  const readLatest = useCallback(() => latest.current, []);

  return (
    <ReadSessionPresentationContext value={readLatest}>
      <SessionPresentationContext value={presentation}>{children}</SessionPresentationContext>
    </ReadSessionPresentationContext>
  );
}

/** Returns the session presentation, and draws again each time it is prepared again. */
export function useSessionPresentation(): SessionPresentation {
  const presentation = use(SessionPresentationContext);
  if (presentation === null) throw new Error("No SessionPresentationProvider above this component");
  return presentation;
}

/**
 * Returns a function that returns the latest session presentation. The
 * function keeps its identity and the component that calls this does not
 * draw again when the presentation changes, so an event handler can read
 * the state of the moment it runs.
 */
export function useReadSessionPresentation(): () => SessionPresentation {
  const read = use(ReadSessionPresentationContext);
  if (read === null) throw new Error("No SessionPresentationProvider above this component");
  return read;
}
