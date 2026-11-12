/**
 * Tests the Inbox screen through the rendered app: the first page of the
 * default list, a push that updates a row in place and holds an arrival
 * behind "N new", the rail changing the list, a typed token narrowing it, the
 * pane showing the current thing's detail, a next page, and the empty states.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
} from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
  // jsdom lays nothing out, so every element is 400 by 600: room for about eleven rows.
  stubElementSize(400, 600);
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  localStorage.clear();
});

const buildThingId = (n: number): string =>
  `01a1b576-c999-7000-8000-${String(n).padStart(12, "0")}`;

/** Returns a review request that has waited since `waitingSince`, raised by `asker`. */
const request = (n: number, title: string, asker: string, overrides: Partial<InboxThing> = {}) =>
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

const SLOTS = request(1, "Cache delivery slot lookups", "Mei");
const LOYALTY = request(2, "Round loyalty points down", "Omar");
const BASKET = request(3, "Fix the basket rounding", "Tessa");

const COUNTS: InboxCounts = buildInboxCounts({
  savedQueries: [
    { id: "waits", name: "Someone waits on me", order: "waiting", count: 3 },
    { id: "mine", name: "Mine", order: "newest", count: 1 },
    { id: "updates", name: "Updates", order: "newest", count: 2 },
    { id: "everything", name: "Everything", order: "newest", count: 6 },
  ],
  fields: [{ key: "team", label: "Team", type: "text" }],
});

const QUERY_PATH = "POST /api/v1/external-entities/inbox/query";

/** Builds the detail the pane reads for `thing`. */
const buildDetail = (thing: InboxThing): ExternalEntityDetail => ({
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
interface FakeInbox {
  lists: Record<string, InboxThing[]>;
  counts: InboxCounts;
  /** The most things one page holds. */
  pageSize: number;
}

/** Builds the controller's answer to one `queryInbox`: a first page, a next page or a `refs` read. */
const answerQuery = (inbox: FakeInbox, call: Call): { body: InboxPage } => {
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
    return { body: { things, total, order: "waiting", offerSets: {} } };
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
      offerSets: {},
    },
  };
};

/** Opens the Inbox on a fake controller. `inbox` is mutable: a test changes it, then pushes. */
const openInbox = async (inbox: FakeInbox) => {
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
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/inbox", retryFailedReads: false },
  );
  return { calls, ...app };
};

const defaultInbox = (): FakeInbox => ({
  lists: {
    waits: [SLOTS, LOYALTY, BASKET],
    mine: [BASKET],
    updates: [],
    everything: [SLOTS, LOYALTY, BASKET],
  },
  counts: COUNTS,
  pageSize: 200,
});

/** Returns the rows of the list by their titles, in order. */
const readRowTitles = (): string[] =>
  within(screen.getByRole("tree"))
    .getAllByRole("treeitem")
    .map((row) => row.querySelector(".ib-row-title")!.textContent ?? "");

/** Returns the bodies of the page reads in `calls`. */
const readQueries = (calls: readonly Call[]): InboxQuery[] =>
  calls
    .filter((call) => `${call.method} ${call.path}` === QUERY_PATH)
    .map((call) => call.body as InboxQuery);

describe("the Inbox screen", () => {
  it("draws the first page of Someone waits on me, with its count, and opens the first thing in the pane", async () => {
    const { calls } = await openInbox(defaultInbox());

    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    expect(
      screen.getByRole("heading", { name: "Someone waits on me" }).parentElement!.textContent,
    ).toContain("3");
    expect(readQueries(calls)[0]).toMatchObject({ list: { savedQuery: "waits" } });
    // The pane shows the current thing, which is the first row.
    await waitFor(() => {
      expect(
        within(document.getElementById("inbox-pane")!).getByRole("heading", {
          name: SLOTS.title,
        }),
      ).toBeTruthy();
    });
  });

  it("updates a held row in place on a push, and holds an arrival behind N new until Show", async () => {
    const inbox = defaultInbox();
    const { live, calls } = await openInbox(inbox);
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });

    const arrival = request(4, "Bump the checkout SDK", "Noa");
    inbox.lists.waits = [
      { ...LOYALTY, title: "Round loyalty points down, again" },
      arrival,
      SLOTS,
      BASKET,
    ];
    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });

    // The changed row updates where it stands, and the arrival does not move anything.
    await screen.findByRole("treeitem", { name: /Round loyalty points down, again/ });
    expect(readRowTitles()).toEqual([
      SLOTS.title,
      "Round loyalty points down, again",
      BASKET.title,
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /1 new/ }));
    expect(readRowTitles()).toContain(arrival.title);
    expect(screen.queryByRole("button", { name: /1 new/ })).toBeNull();
    expect(readQueries(calls).length).toBeGreaterThan(1);
  });

  it("changes the list when a rail entry is picked", async () => {
    const { calls } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Inbox lists" })).getByRole("button", {
        name: /Mine/,
      }),
    );

    await screen.findByRole("heading", { name: "Mine" });
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
    expect(readQueries(calls).at(-1)).toMatchObject({ list: { savedQuery: "mine" } });
  });

  it("narrows the list when a field token is typed", async () => {
    const { calls } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.type(screen.getByRole("combobox"), "team:basket ");

    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
    expect(readQueries(calls).at(-1)).toMatchObject({
      list: { savedQuery: "waits" },
      clauses: [{ key: "team", op: "is", value: "basket" }],
    });
  });

  it("shows the detail of the thing a click makes current", async () => {
    const { calls } = await openInbox(defaultInbox());
    await userEvent.click(
      await screen.findByRole("treeitem", { name: /Round loyalty points down/ }),
    );

    await waitFor(() => {
      expect(
        within(document.getElementById("inbox-pane")!).getByRole("heading", {
          name: LOYALTY.title,
        }),
      ).toBeTruthy();
    });
    expect(calls.some((call) => call.path === `/api/v1/external-entities/${LOYALTY.id}`)).toBe(
      true,
    );
  });

  it("reads the next page when the list nears its end, and holds it with the rest", async () => {
    const inbox = defaultInbox();
    inbox.pageSize = 2;
    const { calls } = await openInbox(inbox);

    await screen.findByRole("treeitem", { name: /Fix the basket rounding/ });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    expect(readQueries(calls).some((query) => query.cursor === "2")).toBe(true);
  });

  it("says nobody waits when the list is empty, and all is clear when nothing is anywhere", async () => {
    const inbox = defaultInbox();
    inbox.lists.waits = [];
    await openInbox(inbox);
    expect(await screen.findByRole("heading", { name: "Nobody waits on you" })).toBeTruthy();
    cleanup();

    const clear = defaultInbox();
    clear.lists.waits = [];
    clear.counts = buildInboxCounts({
      savedQueries: COUNTS.savedQueries.map((query) => ({ ...query, count: 0 })),
    });
    await openInbox(clear);
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeTruthy();
  });
});
