/**
 * The world of the Inbox's integration tests: a fake controller that holds the
 * things of each saved query and answers the page, the counts and the detail
 * the pane reads, and the helpers to open the Inbox on it and read what it
 * draws. `inbox` is mutable: a test changes it, then pushes.
 */
import { screen, within } from "@testing-library/react";
import {
  buildInboxAsk,
  buildInboxCounts,
  buildInboxThing,
} from "@hercule/client-core/inbox/testing";
import type {
  ExternalEntityDetail,
  InboxCounts,
  InboxPage,
  InboxQuery,
  InboxThing,
  WorkflowOffer,
} from "@hercule/contract";
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

export const COUNTS: InboxCounts = buildInboxCounts({
  savedQueries: [
    { id: "waits", name: "Someone waits on me", order: "waiting", count: 3 },
    { id: "mine", name: "Mine", order: "newest", count: 1 },
    { id: "updates", name: "Updates", order: "newest", count: 2 },
    { id: "everything", name: "Everything", order: "newest", count: 6 },
  ],
  fields: [{ key: "team", label: "Team", type: "text" }],
});

export const QUERY_PATH = "POST /api/v1/external-entities/inbox/query";

/** Builds the detail the pane reads for `thing`. */
export const buildDetail = (thing: InboxThing): ExternalEntityDetail => ({
  id: thing.id,
  ref: thing.ref,
  kind: thing.kind,
  noun: thing.noun,
  card: "compact",
  pace: "fast",
  patience: thing.patience,
  identifier: thing.identifier,
  title: thing.title,
  url: thing.url,
  lifecycle: "open",
  yours: false,
  facts: [],
  concerns: [],
  access: "ok",
  observedAt: thing.observedAt,
  stale: false,
  sourceUpdatedAt: thing.sourceUpdatedAt,
  firstObservedAt: thing.observedAt,
  ancestors: [],
  contextComplete: true,
  kindAvailable: true,
  fields: [],
  face: null,
  places: [],
  edges: [],
  links: [],
  hints: [],
  conflicts: [],
  signals: [],
  openCount: 0,
  signalCount: 0,
  timeline: [],
  peers: [],
  offers: [],
  actingConnections: [],
});

/** What the fake controller holds for the Inbox: the things of each saved query, in order, and the counts. */
export interface FakeInbox {
  lists: Record<string, InboxThing[]>;
  counts: InboxCounts;
  /** The most things one page holds. */
  pageSize: number;
  /** The workflows each `offerSetId` of the things offers. */
  offerSets: Record<string, WorkflowOffer[]>;
}

/** Builds the controller's answer to one `queryInbox`: a first page, a next page or a `refs` read. */
export const answerQuery = (inbox: FakeInbox, call: Call): { body: InboxPage } => {
  const query = call.body as InboxQuery;
  const name = "savedQuery" in query.list ? query.list.savedQuery : "browse";
  let things = inbox.lists[name] ?? [];
  // The fake narrows by any clause value found in a title, which is all the tests need of a filter.
  const values = (query.clauses ?? []).map((clause) => String(clause.value).toLowerCase());
  things = things.filter((thing) =>
    values.every((value) => thing.title.toLowerCase().includes(value)),
  );
  const total = things.length;
  if (query.refs !== undefined) {
    const wanted = new Set<string>(query.refs);
    things = things.filter((thing) => wanted.has(thing.ref));
    return { body: { things, total, order: "waiting", offerSets: inbox.offerSets } };
  }
  const from = query.cursor === undefined ? 0 : Number(query.cursor);
  const page = things.slice(from, from + inbox.pageSize);
  const next = from + inbox.pageSize;
  return {
    body: {
      things: page,
      total,
      order: name === "waits" ? "waiting" : "newest",
      ...(next < things.length ? { nextCursor: String(next) } : {}),
      offerSets: inbox.offerSets,
    },
  };
};

/** Opens the Inbox on a fake controller. `inbox` is mutable: a test changes it, then pushes. */
export const openInbox = async (
  inbox: FakeInbox,
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  const all = Object.values(inbox.lists).flat();
  const entityHandlers: Record<string, Handler> = Object.fromEntries(
    all.map((thing) => [
      `GET /api/v1/external-entities/${thing.id}`,
      () => ({ body: buildDetail(thing) }),
    ]),
  );
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/external-entities/inbox/count": () => ({ body: inbox.counts }),
    [QUERY_PATH]: (call: Call) => answerQuery(inbox, call),
    ...entityHandlers,
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/inbox", retryFailedReads: false },
  );
  return { calls, ...app };
};

export const defaultInbox = (): FakeInbox => ({
  lists: {
    waits: [SLOTS, LOYALTY, BASKET],
    mine: [BASKET],
    updates: [],
    everything: [SLOTS, LOYALTY, BASKET],
  },
  counts: COUNTS,
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
