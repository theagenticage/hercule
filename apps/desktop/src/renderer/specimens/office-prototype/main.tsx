/**
 * PROTOTYPE - the 3D office page: the app's real shell and sidebar, with the
 * office in the main pane, drawn from the office's world. Like the shell
 * specimens, it talks to no controller: the query cache holds every record
 * the page reads, the client refuses every request, and the bridge refuses
 * every call.
 *
 * Every control lives in the URL (see office-store.ts). A change of fleet
 * size reloads the page, because the sidebar reads the world's records once.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "../fixed-clock";
import "../../styles/base-layer.css";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { JSX } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createClient, type FetchLike } from "@hercule/client-core";
import { createPendingSubmissions } from "../../app/pending-submissions";
import { createQueryClient } from "../../app/query-client";
import { Shell } from "../../shell";
import { CONTROLLER_URL, REFUSING_BRIDGE, refuseRequest, seedQueryCache } from "../shell-page";
import { sessionQuery, threadsQuery } from "../../app/queries";
import {
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  setOffice,
  subscribeColleagueStates,
  subscribeOffice,
} from "./office-store";
import { sendAnswer } from "./ui/answers";
import { OfficeView } from "./ui/office-view";
import { VariantBar } from "./ui/variant-bar";
import { buildWorld } from "./world/fixture";
import { buildLiveSession, buildSidebarRecords } from "./world/records";
import { buildThreadScreenRecords } from "./world/transcripts";

const initial = readOffice();
const world = buildWorld(initial.fleet);
const records = buildSidebarRecords(world);
const threadIds = new Set(records.threads.map((thread) => thread.id));

/** The path of the two requests the thread drawer's dock answers a colleague with. */
const RESPOND_PATH = /^\/api\/v1\/sessions\/([^/]+)\/respond-to-(?:approval-request|question)$/;

/**
 * Answers the dock's respond requests as the office's controller would, and
 * refuses every other request. The answer goes to the office like an answer
 * from the dossier card, so the colleague leaves the queue either way. The
 * response is the session still waiting, as a real controller returns it.
 */
const serveRequest: FetchLike = async (url, init) => {
  const colleagueId = RESPOND_PATH.exec(new URL(url).pathname)?.[1];
  const colleague = world.colleagues.find((each) => each.id === colleagueId);
  if (colleague === undefined) return refuseRequest(url, init);
  const session = queryClient.getQueryData(sessionQuery(client, colleague.id).queryKey);
  // The client sends the payload as bytes, not as a string.
  const body = (await new Response(init?.body).json()) as { decision?: string };
  sendAnswer(colleague, body.decision ?? "answered");
  return new Response(JSON.stringify(session), { headers: { "content-type": "application/json" } });
};

const client = createClient({ baseUrl: CONTROLLER_URL, fetch: serveRequest });
const queryClient = createQueryClient();
// Nothing can read a seeded record again, so the cache keeps every one: a
// thread nobody has opened for five minutes must still open.
const defaults = queryClient.getDefaultOptions();
queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, gcTime: Infinity } });
for (const thread of buildThreadScreenRecords(world, records.threads)) {
  seedQueryCache(queryClient, client, records, { thread });
}

/** Draws the shell with the office in its main pane. New thread brings a new colleague into the office. */
function OfficeShell(): JSX.Element {
  return (
    <Shell onNewThread={() => sendOfficeCommand({ kind: "simulate", event: { kind: "arrive" } })}>
      <OfficeView world={world} />
      <Outlet />
    </Shell>
  );
}

const rootRoute = createRootRoute();
const connectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_connected",
  beforeLoad: () => ({
    bridge: REFUSING_BRIDGE,
    controller: {
      url: CONTROLLER_URL,
      client,
      live: null,
      pendingSubmissions: createPendingSubmissions(),
    },
  }),
});
const shellRoute = createRoute({
  getParentRoute: () => connectedRoute,
  id: "_shell",
  component: OfficeShell,
});
// The office draws itself in the shell's layout, so no route draws anything:
// a thread's route only tells the office which colleague is selected.
const router = createRouter({
  routeTree: rootRoute.addChildren([
    connectedRoute.addChildren([
      shellRoute.addChildren([
        createRoute({ getParentRoute: () => shellRoute, path: "/", component: () => null }),
        createRoute({ getParentRoute: () => shellRoute, path: "office", component: () => null }),
        createRoute({
          getParentRoute: () => shellRoute,
          path: "threads/$sessionId",
          component: () => null,
        }),
      ]),
    ]),
  ]),
  history: createMemoryHistory({
    initialEntries: [
      initial.selectedId !== null && threadIds.has(initial.selectedId)
        ? `/threads/${initial.selectedId}`
        : "/office",
    ],
  }),
});

/** Returns the id of the thread the router's address opens, or null. */
const readRouteThreadId = (): string | null =>
  /^\/threads\/([^/]+)$/.exec(router.state.location.pathname)?.[1] ?? null;

// The sidebar marks the thread the address opens, and the office marks the
// selected colleague. These two keep them the same, whichever side moved. A
// thread the sidebar opens also opens the drawer, as a thread opens its page
// in the app; one the office selects leaves the drawer as it is.
router.subscribe("onResolved", () => {
  const id = readRouteThreadId();
  if (id !== null && id !== readOffice().selectedId) {
    setOffice({ selectedId: id, roomId: null, drawer: true });
  }
});
subscribeOffice(() => {
  const { selectedId, fleet } = readOffice();
  if (fleet !== initial.fleet) {
    location.reload();
    return;
  }
  const routeId = readRouteThreadId();
  if (selectedId !== null && threadIds.has(selectedId)) {
    // The history, not `navigate`: the app's route tree types `navigate`, and it has no office route.
    if (selectedId !== routeId) router.history.push(`/threads/${selectedId}`);
  } else if (routeId !== null) {
    router.history.push("/office");
  }
});

// The sidebar and the thread drawer follow the office's sim: a colleague who
// starts waiting shows under Waiting on you with its request in the dock,
// and one the user answered leaves both.
let previousStates = readColleagueStates();
subscribeColleagueStates(() => {
  const states = readColleagueStates();
  for (const colleague of world.colleagues) {
    const live = states.get(colleague.id);
    if (live === previousStates.get(colleague.id) || !threadIds.has(colleague.id)) continue;
    const session = buildLiveSession(colleague, live);
    queryClient.setQueryData(threadsQuery(client).queryKey, (threads) =>
      threads?.map((each) => (each.id === session.id ? session : each)),
    );
    queryClient.setQueryData(sessionQuery(client, session.id).queryKey, session);
  }
  previousStates = states;
});

await router.load();
const root = document.getElementById("root");
if (root === null) throw new Error("The office page is missing #root.");
flushSync(() => {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <VariantBar />
    </QueryClientProvider>,
  );
});
