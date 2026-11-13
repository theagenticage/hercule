/**
 * The world of the Inbox's integration tests: a fake controller that holds the
 * things of each saved query and answers the page, the counts, the outline and the detail
 * the pane reads, and the helpers to open the Inbox on it and read what it
 * draws. `inbox` is mutable: a test changes it, then pushes.
 */
import { screen, within } from "@testing-library/react";
import {
  answerFakeInboxQuery,
  buildFakeInboxDetail,
  buildInboxAsk,
  buildInboxOutline,
  buildInboxThing,
  type FakeInbox,
} from "@hercule/client-core/inbox/testing";
import type { InboxOutline, InboxQuery, InboxReply, InboxThing } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

export type { FakeInbox } from "@hercule/client-core/inbox/testing";

export const buildThingId = (n: number): string =>
  `01a1b576-c999-7000-8000-${String(n).padStart(12, "0")}`;

/** Returns a review request that has waited since `waitingSince`, raised by `asker`. */
export const request = (
  n: number,
  title: string,
  asker: string,
  overrides: Partial<InboxThing> = {},
) =>
  buildInboxThing(String(n), {
    id: buildThingId(n),
    // A larger number arrived later, which is how the list tells an arrival from a row it holds.
    arrival: n,
    title,
    asks: [buildInboxAsk(buildThingId(100 + n), asker)],
    askCount: 1,
    askKinds: ["acme/review-requested"],
    openKinds: ["acme/review-requested"],
    waitingSince: "2026-11-07T09:00:00.000Z",
    ...overrides,
  });

export const SLOTS = request(1, "Cache delivery slot lookups", "Mei");
export const LOYALTY = request(2, "Round loyalty points down", "Omar");
export const BASKET = request(3, "Fix the basket rounding", "Tessa");

export const OUTLINE: InboxOutline = buildInboxOutline({
  savedQueries: [
    { id: "waits", name: "Someone waits on me", order: "waiting", signalKinds: [], count: 3 },
    { id: "mine", name: "Mine", order: "newest", signalKinds: [], count: 1 },
    { id: "updates", name: "Updates", order: "newest", signalKinds: [], count: 2 },
    { id: "everything", name: "Everything", order: "newest", signalKinds: [], count: 6 },
  ],
  fields: [{ key: "team", label: "Team", type: "text" }],
});

export const QUERY_PATH = "POST /api/v1/external-entities/inbox/query";

/** Answers one `queryInbox` call from `inbox`, as the controller would. */
export const answerQuery = (inbox: FakeInbox, call: Call): { body: InboxReply } => ({
  body: answerFakeInboxQuery(inbox, call.body as InboxQuery),
});

/**
 * Opens the Inbox on a fake controller, at `path` (the Inbox's own address, with
 * its search params, by default). `inbox` is mutable: a test changes it, then pushes.
 */
export const openInbox = async (
  inbox: FakeInbox,
  handlers: Readonly<Record<string, Handler>> = {},
  path = "/inbox",
) => {
  const all = Object.values(inbox.lists).flat();
  const entityHandlers: Record<string, Handler> = Object.fromEntries(
    all.map((thing) => [
      `GET /api/v1/external-entities/${thing.id}`,
      () => ({ body: buildFakeInboxDetail(thing) }),
    ]),
  );
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/external-entities/inbox/count": () => ({
      body: {
        waiting: inbox.outline.savedQueries.find((query) => query.id === "waits")?.count ?? 0,
        newestArrival: inbox.newestArrival,
      },
    }),
    "GET /api/v1/external-entities/inbox/outline": () => ({ body: inbox.outline }),
    [QUERY_PATH]: (call: Call) => answerQuery(inbox, call),
    ...entityHandlers,
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path, retryFailedReads: false },
  );
  // The shell's first pushes make the visit read the list again. Let those reads finish, so a
  // test acts on a list that holds still and counts only the reads it causes.
  await app.live.waitForFirstPushes();
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, ...app };
};

export const defaultInbox = (): FakeInbox => ({
  lists: {
    waits: [SLOTS, LOYALTY, BASKET],
    mine: [BASKET],
    updates: [],
    everything: [SLOTS, LOYALTY, BASKET],
  },
  outline: OUTLINE,
  newestArrival: 0,
  pageSize: 200,
  offerSets: {},
});

/** Returns the rows of the list by their titles, in order. */
export const readRowTitles = (): string[] =>
  within(screen.getByRole("tree"))
    .getAllByRole("treeitem")
    .map((row) => row.querySelector(".ib-row-title")!.textContent ?? "");

/** Returns the bodies of the page reads in `calls`. */
export const readQueries = (calls: readonly Call[]): InboxQuery[] =>
  calls
    .filter((call) => `${call.method} ${call.path}` === QUERY_PATH)
    .map((call) => call.body as InboxQuery);
