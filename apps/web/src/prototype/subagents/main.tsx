/**
 * PROTOTYPE (#354), throwaway. Runs the real web app on the thread screen,
 * against a stubbed controller that serves the subagents fixture. The real
 * client decodes every record, and the real router, shell and thread screen
 * draw it; the prototype fills the slots in `prototype-hooks.ts`.
 *
 * Start it with `pnpm --filter @hercule/web exec vite`, then open
 * `/src/prototype/subagents/index.html?state=busy&theme=light`.
 */
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, createLive } from "@hercule/client-core";
import { createApiStub, stubWebSocketInto, type Handler } from "@hercule/client-core/testing";
import { createAppRouter } from "../../app/router";
import { followLiveStatus } from "../../app/live-status";
import { prototypeHooks } from "../../screens/thread/prototype-hooks";
import {
  INSTANCE,
  OTHER_SESSIONS,
  PROFILE,
  PROJECT,
  RESOURCE,
  RUNNER,
  THREAD_ID,
  WORKSPACE,
} from "./fixture";
import { Knobs, PaneToggle, RequestPager, SpawnLines, TallyPill } from "./parts";
import { SidePane } from "./side-pane";
import { SubagentPageOrThread } from "./subagent-page";
import {
  answerRequest,
  attachCache,
  buildMainSession,
  readProto,
  SCENARIO,
  stopEverything,
  applyThemeParam,
} from "./store";
import "../../styles.css";

applyThemeParam();

const session = `/api/v1/sessions/${THREAD_ID}`;
const handlers: Readonly<Record<string, Handler>> = {
  "POST /api/v1/auth/ws-ticket": { body: { ticket: "ws-ticket" } },
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: {
        "onboarding.completedSteps": ["timezone", "assistant"],
        timezone: "Europe/Amsterdam",
      },
    },
  },
  "GET /api/v1/providers": { body: [INSTANCE] },
  "GET /api/v1/runners": { body: { items: [RUNNER] } },
  "GET /api/v1/profiles": { body: { items: [PROFILE] } },
  "GET /api/v1/assistants": { body: { items: [] } },
  "GET /api/v1/connections": { body: { items: [] } },
  "GET /api/v1/projects": { body: { items: [PROJECT] } },
  "GET /api/v1/workspaces": { body: { items: [WORKSPACE] } },
  "GET /api/v1/resources": { body: { items: [RESOURCE] } },
  "GET /api/v1/sessions": () => ({
    body: { items: [buildMainSession(readProto()), ...OTHER_SESSIONS] },
  }),
  [`GET ${session}`]: () => ({ body: buildMainSession(readProto()) }),
  [`GET ${session}/transcript`]: { body: { items: SCENARIO.mainRows } },
  [`GET ${session}/inputs`]: { body: { items: [] } },
  [`POST ${session}/respond-to-approval-request`]: (call) => {
    answerRequest((call.body as { requestId: string }).requestId);
    return { body: buildMainSession(readProto()) };
  },
  [`POST ${session}/interrupt`]: () => {
    stopEverything();
    return { body: buildMainSession(readProto()) };
  },
};

const baseUrl = "http://controller.invalid";
const client = createClient({ baseUrl, fetch: createApiStub(handlers).fetch, token: "held" });
const live = createLive({ client, baseUrl, webSocket: stubWebSocketInto([]) });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
attachCache(queryClient);
const router = createAppRouter(
  { client, queryClient, live, detectLocalRunner: () => Promise.resolve(null) },
  createMemoryHistory({ initialEntries: [`/threads/${THREAD_ID}`] }),
);
followLiveStatus(live, router);

prototypeHooks.renderSidePane = () => <SidePane />;
prototypeHooks.renderHeaderActions = () => <PaneToggle />;
prototypeHooks.renderAboveComposer = () => <TallyPill />;
prototypeHooks.renderAboveRequest = () => <RequestPager />;
prototypeHooks.renderSpawnLines = (turn) => <SpawnLines turnId={turn.turnId} />;
prototypeHooks.wrapThreadScreen = (thread) => (
  <SubagentPageOrThread client={client} thread={thread} />
);

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
    <Knobs />
  </QueryClientProvider>,
);
