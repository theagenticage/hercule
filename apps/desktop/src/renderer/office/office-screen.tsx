/**
 * The Office screen: the user's threads and assistants drawn as colleagues
 * in the 3D Office. It reads the same records as the sidebar, so the Office
 * changes as soon as a thread or an assistant does.
 *
 * The route's `session` and `assistant` search params and the Office's
 * store hold the same thing: what the drawer shows, a thread or an
 * assistant's Conversation. A change of a param opens or closes the drawer,
 * and the user opening or closing the drawer in the Office changes the
 * param. So a sidebar row, the Go menu and a notification open a thread or
 * an assistant in the drawer by linking to it, and the sidebar marks the row
 * the drawer shows.
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  ensureConversationData,
  ensureThreadData,
  localRunnerQuery,
  projectsQuery,
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
 * Returns what the drawer shows for the colleague id `id`: a thread or an
 * assistant, as the colleague in `world` with that id is. An id with no
 * colleague can only have come from the route, so it keeps the kind of
 * `routeOpen`, the last thing the route opened. Returns null for an id that
 * neither knows.
 */
const decideOpenColleague = (
  id: string,
  world: World,
  routeOpen: OpenColleague | null,
): OpenColleague | null => {
  const colleague = world.colleagues.find((each) => each.id === id);
  if (colleague !== undefined) return { kind: colleague.kind, id };
  return routeOpen?.id === id ? routeOpen : null;
};

/**
 * Renders the Office. `open` is the thread or the assistant the drawer
 * shows, or null for a closed drawer; `onOpen` is called with what the user
 * opens in the drawer, or with null when the user closes it.
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
  const sessions = useSuspenseQuery(threadsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const localRunnerId = useQuery(localRunnerQuery(bridge, runners)).data ?? null;
  // The sidebar's rows, which the shell already reads: no read of its own.
  const assistants = useAssistantRows();
  const world = useMemo(
    () => buildWorld({ sessions, projects, workspaces, runners, assistants, localRunnerId }),
    [sessions, projects, workspaces, runners, assistants, localRunnerId],
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

  // Reads the selected colleague's thread or Conversation while its card
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
