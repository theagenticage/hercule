/**
 * The Office screen: the user's threads drawn as colleagues in the 3D
 * Office. It reads the same records as the sidebar, so the Office changes
 * as soon as a thread does.
 *
 * The route's `session` search param and the Office's store say the same
 * thing: which thread the drawer shows. A change of the param opens or
 * closes the drawer, and the user opening or closing the drawer in the
 * Office changes the param, so Back closes a drawer the user opened and a
 * link can open the Office on a thread.
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { ageClock } from "../app/age-clock";
import {
  localRunnerQuery,
  projectsQuery,
  runnersQuery,
  threadsQuery,
  workspacesQuery,
} from "../app/queries";
import { readOffice, setOffice, subscribeOffice } from "./office-store";
import { OfficeView } from "./ui/office-view";
import { buildWorld } from "./world/build-world";

/**
 * Renders the Office. `openSessionId` is the thread the drawer shows, or
 * null for a closed drawer; `onOpenThread` is called with the thread the
 * user opens in the drawer, or with null when the user closes it.
 */
export function OfficeScreen({
  openSessionId,
  onOpenThread,
}: {
  readonly openSessionId: string | null;
  readonly onOpenThread: (sessionId: string | null) => void;
}): JSX.Element {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const sessions = useSuspenseQuery(threadsQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const localRunnerId = useQuery(localRunnerQuery(bridge, runners)).data ?? null;
  // The age clock's time, so a request's minutes agree with the sidebar's
  // age label for the same thread.
  const world = useMemo(
    () =>
      buildWorld(
        { sessions, projects, workspaces, runners, localRunnerId },
        ageClock.readNow().getTime(),
      ),
    [sessions, projects, workspaces, runners, localRunnerId],
  );

  // The latest param and callback, read by the store's subscriber, which is
  // made once for as long as the screen is mounted.
  const shownRef = useRef(openSessionId);
  const onOpenThreadRef = useRef(onOpenThread);
  useEffect(() => {
    onOpenThreadRef.current = onOpenThread;
  });

  useEffect(() => {
    shownRef.current = openSessionId;
    if (openSessionId === null) setOffice({ drawer: false });
    else setOffice({ selectedId: openSessionId, drawer: true, roomId: null });
  }, [openSessionId]);

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
      const shown = drawer ? selectedId : null;
      if (shown === shownRef.current) return;
      shownRef.current = shown;
      onOpenThreadRef.current(shown);
    });
    return () => {
      unsubscribe();
      // The store outlives the screen. The next visit starts on the overview.
      setOffice({ hoveredId: null, selectedId: null, drawer: false, roomId: null });
    };
  }, []);

  return <OfficeView world={world} />;
}
