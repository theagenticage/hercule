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
import { createClient } from "@hercule/client-core";
import { createPendingSubmissions } from "../../app/pending-submissions";
import { createQueryClient } from "../../app/query-client";
import { Shell } from "../../shell";
import { FIX_THREAD } from "../thread-fixture";
import { CONTROLLER_URL, REFUSING_BRIDGE, refuseRequest, seedQueryCache } from "../shell-page";
import { readOffice, sendOfficeCommand, setOffice, subscribeOffice } from "./office-store";
import { OfficeView } from "./ui/office-view";
import { VariantBar } from "./ui/variant-bar";
import { buildWorld } from "./world/fixture";
import { buildSidebarRecords } from "./world/records";

const initial = readOffice();
const world = buildWorld(initial.fleet);
const records = buildSidebarRecords(world);
const threadIds = new Set(records.threads.map((thread) => thread.id));

const client = createClient({ baseUrl: CONTROLLER_URL, fetch: refuseRequest });
const queryClient = createQueryClient();
seedQueryCache(queryClient, client, records, { thread: FIX_THREAD });

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
// selected colleague. These two keep them the same, whichever side moved.
router.subscribe("onResolved", () => {
  const id = readRouteThreadId();
  if (id !== null && id !== readOffice().selectedId) setOffice({ selectedId: id, roomId: null });
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
