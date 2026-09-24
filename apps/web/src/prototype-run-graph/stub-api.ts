/**
 * PROTOTYPE - throwaway (P021 run graph, branch prototype/P021-run-graph).
 *
 * An in-memory controller for `vite --mode prototype`: it answers the reads
 * the shell makes on every screen, so the prototype route renders inside the
 * real sidebar and top bar with no controller running and no Hercule Home.
 * Every list is empty; any other GET answers an empty page.
 */
import type { FetchLike } from "@hercule/client-core";
import { stubWebSocketInto, type StubSocket } from "@hercule/client-core/testing";

const ANSWERS: Readonly<Record<string, unknown>> = {
  "GET /api/v1/setup": { complete: true },
  "GET /api/v1/settings": {
    controller: {},
    user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
  },
  "GET /api/v1/plugins": [],
  "GET /api/v1/providers": [],
  "GET /api/v1/controller": {
    id: "01a06d02-a000-7000-8000-000000000001",
    publicKey: "bm90LWEta2V5",
    version: "0.1.0",
    defaultRunnerId: null,
  },
  "POST /api/v1/auth/ws-ticket": { ticket: "ws-ticket" },
};

export const stubFetch: FetchLike = (url, init) => {
  const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
  const body = ANSWERS[key] ?? { items: [] };
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  );
};

const sockets: StubSocket[] = [];
export const stubWebSocket = stubWebSocketInto(sockets);
