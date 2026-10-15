/**
 * The Office screen: the user's sessions and assistants drawn as colleagues
 * in the 3D Office. It reads the same records as the sidebar and the
 * workflow list, so the Office changes as soon as a session, a run or an
 * assistant does.
 *
 * The route's `session` and `assistant` search params and the Office's
 * store hold the same thing: what the drawer shows, a session's screen or an
 * assistant's Conversation. A change of a param opens or closes the drawer,
 * and the user opening or closing the drawer in the Office changes the
 * param. So a sidebar row, the Go menu and a notification open a session or
 * an assistant in the drawer by linking to it, and the sidebar marks the row
 * the drawer shows.
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Session } from "@hercule/contract";
import { RUN_TOPICS, useScreenTopicsLive } from "../app/live";
import {
  ensureConversationData,
  ensureThreadData,
  liveAgentSessionsQuery,
  liveRunSessionsQuery,
  liveRunsQuery,
  localRunnerQuery,
  projectsQuery,
  resourcesQuery,
  runnersQuery,
  threadsQuery,
  workspacesQuery,
} from "../app/queries";
import { useAssistantRows } from "../app/assistant-rows";
import { readOffice, setOffice, subscribeOffice, type OpenColleague } from "./office-store";
import { OfficeView } from "./ui/office-view";
import { buildWorld } from "./world/build-world";
import type { World } from "./world/types";

/**
 * Returns what the drawer shows for the colleague id `id`: an assistant's
 * Conversation for an assistant, and the session's screen for any other
 * colleague in `world`. An id with no colleague can only have come from the
 * route, so it keeps the kind of `routeOpen`, the last thing the route
 * opened. Returns null for an id that neither knows.
 */
const decideOpenColleague = (
  id: string,
  world: World,
  routeOpen: OpenColleague | null,
): OpenColleague | null => {
  const colleague = world.colleagues.find((each) => each.id === id);
  if (colleague !== undefined)
    return { kind: colleague.kind === "assistant" ? "assistant" : "session", id };
  return routeOpen?.id === id ? routeOpen : null;
};

/**
 * Returns every session the Office may seat, each once: the threads, and
 * the Agents' sessions, both those still live and those of the live runs,
 * which can have exited. A session in both Agent lists is taken from
 * `runSessions`.
 */
const listOfficeSessions = (
  threads: readonly Session[],
  liveAgentSessions: readonly Session[],
  runSessions: readonly Session[],
): Session[] => {
  const agentSessions = new Map(liveAgentSessions.map((session) => [session.id, session]));
  for (const session of runSessions) agentSessions.set(session.id, session);
  return [...threads, ...agentSessions.values()];
};

/** The run sessions before their first read, the same array every time. */
const NO_SESSIONS: readonly Session[] = [];

/**
 * Renders the Office. `open` is the session or the assistant the drawer
 * shows, or null for a closed drawer; `onOpen` is called with what the user
 * opens in the drawer, or with null when the user closes it.
 *
 * While the Office is open and the window shows, it holds the `run` topic,
 * so a run that starts or ends brings its sessions in or takes them out.
 */
export function OfficeScreen({
  open,
  onOpen,
}: {
  readonly open: OpenColleague | null;
  readonly onOpen: (colleague: OpenColleague | null) => void;
}): JSX.Element {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const queryClient = useQueryClient();
  useScreenTopicsLive(controller.live, queryClient, RUN_TOPICS);
  const threads = useSuspenseQuery(threadsQuery(client)).data;
  const liveAgentSessions = useSuspenseQuery(liveAgentSessionsQuery(client)).data;
  const running = useSuspenseQuery(liveRunsQuery(client, "running")).data;
  const pending = useSuspenseQuery(liveRunsQuery(client, "pending")).data;
  const liveRuns = useMemo(() => [...running, ...pending], [running, pending]);
  // A new run's sessions are read in the background, so the Office never
  // hides while it reads them: until then it keeps the last read, and the
  // live Agent sessions already hold the new run's live ones. A read that
  // fails for a set of runs it never read throws to the route's error
  // screen: answering with no sessions would take a live run's finished
  // sessions out of the Office as if the run had ended.
  const runSessions =
    useQuery({
      ...liveRunSessionsQuery(
        client,
        liveRuns.map((run) => run.id),
      ),
      placeholderData: keepPreviousData,
      throwOnError: (_error, query) => query.state.data === undefined,
    }).data ?? NO_SESSIONS;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const localRunnerId = useQuery(localRunnerQuery(bridge, runners)).data ?? null;
  // The sidebar's rows, which the shell already reads: no read of its own.
  const assistants = useAssistantRows();
  const sessions = useMemo(
    () => listOfficeSessions(threads, liveAgentSessions, runSessions),
    [threads, liveAgentSessions, runSessions],
  );
  const world = useMemo(
    () =>
      buildWorld({
        sessions,
        liveRuns,
        projects,
        workspaces,
        resources,
        runners,
        assistants,
        localRunnerId,
      }),
    [sessions, liveRuns, projects, workspaces, resources, runners, assistants, localRunnerId],
  );

  // The latest world and callback, and what the route last opened, read by
  // the store's subscribers, which are made once for as long as the screen
  // is mounted. The store holds only the selected id, so the subscribers
  // find its kind in the world, or in what the route opened.
  const shownIdRef = useRef(open?.id ?? null);
  const routeOpenRef = useRef(open);
  const worldRef = useRef(world);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    worldRef.current = world;
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    shownIdRef.current = open?.id ?? null;
    if (open === null) {
      setOffice({ drawer: false });
      return;
    }
    routeOpenRef.current = open;
    setOffice({ selectedId: open.id, drawer: true, roomId: null });
  }, [open]);

  // Reads the selected colleague's session or Conversation while its card
  // shows, so Open thread or Open conversation finds it cached and the
  // drawer slides in with the transcript rather than an empty panel. A read
  // that fails here is left to the route's loader, which reads again when
  // the drawer opens.
  useEffect(() => {
    let readId: string | null = null;
    return subscribeOffice(() => {
      const { selectedId } = readOffice();
      if (selectedId === null || selectedId === readId) return;
      readId = selectedId;
      const selected = decideOpenColleague(selectedId, worldRef.current, routeOpenRef.current);
      if (selected === null) return;
      const read =
        selected.kind === "assistant"
          ? ensureConversationData(queryClient, client, selected.id)
          : ensureThreadData(queryClient, client, selected.id);
      read.catch(() => undefined);
    });
  }, [queryClient, client]);

  // Nothing in the window is see-through while the Office is open: see the
  // data-office rule in base.css for why.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.office = "open";
    return () => {
      delete root.dataset.office;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOffice(() => {
      const { drawer, selectedId } = readOffice();
      const shownId = drawer ? selectedId : null;
      if (shownId === shownIdRef.current) return;
      const shown =
        shownId === null
          ? null
          : decideOpenColleague(shownId, worldRef.current, routeOpenRef.current);
      if (shownId !== null && shown === null) return;
      shownIdRef.current = shownId;
      onOpenRef.current(shown);
    });
    return () => {
      unsubscribe();
      // The store outlives the screen. The next visit starts on the overview.
      setOffice({ hoveredId: null, selectedId: null, drawer: false, roomId: null });
    };
  }, []);

  return <OfficeView world={world} open={open} />;
}
