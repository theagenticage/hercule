/**
 * The records of the Inbox specimen (inbox.tsx): the invented Northwind
 * Market world as the controller would answer the Inbox's reads at the
 * specimen's clock, Tuesday 29 September 2026, 09:41 UTC.
 *
 * Three invented-or-public sources feed it: GitHub (pull requests), Tidewatch
 * (a planning tracker: tickets in projects and teams) and Sentry (issues).
 * Every person, company and repository is invented.
 *
 * `answerInboxQuery` plays the controller's `queryInbox`: it picks the things
 * of a saved query or a Browse value, applies the search's clauses and text,
 * and answers the first page with its facets. The page's state (`?state=`) is
 * one of `INBOX_SCENES`: what the fixture changes (the counts, the answer, the
 * connection) and what the page does after it draws (`play`).
 */
import type {
  Connection,
  EntityBlocks,
  ExternalEntityDetail,
  InboxOutline,
  InboxFacet,
  InboxFirstPage,
  InboxQuery,
  InboxReply,
  InboxValueQuery,
  InboxValues,
  InboxThing,
  PluginDetail,
  Signal,
} from "@hercule/contract";
import { CORE_SAVED_QUERY_IDS } from "@hercule/contract";
import { buildInboxAsk, buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import {
  buildAskSignal,
  buildId,
  DETAIL_EXTRAS,
  hoursAgo,
  MENTION,
  PANE_BLOCKS,
  REGRESSED,
  REVIEW,
} from "./inbox-pane-fixture";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import { buildPlugin, GITHUB_PLUGIN, SENTRY_MARK, TIDEWATCH_PLUGIN } from "./plugins-fixture";
import type { SidebarRecords } from "./shell-page";

/** What the fixture knows of a thing besides the row: the values Browse, Narrow and tokens filter on. */
interface Tags {
  readonly repo?: string;
  readonly project?: string;
  readonly team?: string;
  readonly from?: string;
}

interface Item {
  readonly thing: InboxThing;
  readonly tags: Tags;
  /** The saved queries the thing belongs to, besides Everything. */
  readonly lists: ReadonlyArray<string>;
}

const OFFER_SETS = {
  "github/pull-request": [
    { ...buildWorkflowOffer("Review PR", [REVIEW]), workflowId: buildId(700) },
  ],
};

const text = (key: string, label: string, value: string) => ({
  key,
  label,
  type: "text" as const,
  text: value,
});

const pullRequest = (
  n: number,
  number: number,
  title: string,
  asks: ReadonlyArray<{
    readonly kind: string;
    readonly noun: string;
    readonly asker: string;
    readonly say: string;
    readonly hours: number;
  }>,
  repo: string,
  overrides: Partial<InboxThing> = {},
  lists: ReadonlyArray<string> = ["waits"],
): Item => ({
  tags: { repo, team: "Checkout", from: asks[0]?.asker ?? "Mei" },
  lists,
  thing: {
    id: buildId(n),
    ref: `github:pull-request:acme/${repo}#${String(number)}`,
    kind: "github/pull-request",
    noun: "Pull request",
    source: "github",
    identifier: `#${String(number)}`,
    title,
    url: `https://github.example/acme/${repo}/pull/${String(number)}`,
    access: "ok",
    stale: false,
    observedAt: hoursAgo(0.1),
    sourceUpdatedAt: hoursAgo(asks[0]?.hours ?? 4),
    patience: 24,
    face: { place: text("repo", "Repository", repo) },
    asks: asks.map((ask, index) => ({
      ...buildInboxAsk(buildId(500 + n * 10 + index), ask.asker, {
        kind: ask.kind,
        noun: ask.noun,
        createdAt: hoursAgo(ask.hours),
      }),
      say: { say: ask.say, tone: "plain" as const },
    })),
    askCount: asks.length,
    askKinds: [...new Set(asks.map((ask) => ask.kind))],
    openKinds: [...new Set(asks.map((ask) => ask.kind))],
    takenOn: false,
    arrival: 0,
    ...(asks.length === 0
      ? {}
      : { waitingSince: hoursAgo(Math.max(...asks.map((ask) => ask.hours))) }),
    liveWorkflows: [],
    offerSetId: "github/pull-request",
    actingConnections: [],
    accounts: [buildId(900)],
    ...overrides,
  },
});

const ticket = (
  n: number,
  number: number,
  title: string,
  project: string,
  lists: ReadonlyArray<string>,
  hours: number,
  overrides: Partial<InboxThing> = {},
): Item => ({
  tags: { project, team: "Storefront" },
  lists,
  thing: {
    id: buildId(n),
    ref: `tidewatch:ticket:shop-${String(number)}`,
    kind: "tidewatch/ticket",
    noun: "Ticket",
    source: "tidewatch",
    identifier: `SHOP-${String(number)}`,
    title,
    url: `https://tidewatch.example/shop/${String(number)}`,
    status: { shape: "half", tone: "active", label: "In progress" },
    access: "ok",
    stale: false,
    observedAt: hoursAgo(0.1),
    sourceUpdatedAt: hoursAgo(hours),
    patience: 72,
    face: { context: text("project", "Project", project) },
    asks: [],
    askCount: 0,
    askKinds: [],
    openKinds: [],
    takenOn: false,
    arrival: 0,
    liveWorkflows: [],
    offerSetId: "none",
    actingConnections: [],
    accounts: [buildId(901)],
    ...overrides,
  },
});

const ITEMS: ReadonlyArray<Item> = [
  pullRequest(
    1,
    6244,
    "Show the delivery cost on the payment step",
    [
      { kind: MENTION, noun: "mention", asker: "Omar", say: "Omar mentioned you", hours: 2 },
      {
        kind: REVIEW,
        noun: "review request",
        asker: "Mei",
        say: "Mei asked for your review",
        hours: 26,
      },
    ],
    "storefront-web",
    { status: { shape: "cross", tone: "bad", label: "Checks failing" } },
  ),
  pullRequest(
    2,
    6213,
    "Move the order schema to the shared package",
    [
      {
        kind: REVIEW,
        noun: "review request",
        asker: "Tessa",
        say: "Tessa asked for your review",
        hours: 30,
      },
    ],
    "storefront-web",
  ),
  pullRequest(
    3,
    6260,
    "Retry card payments once before failing the order",
    [
      {
        kind: REVIEW,
        noun: "review request",
        asker: "Theo",
        say: "Theo asked for your review",
        hours: 96,
      },
    ],
    "platform-core",
  ),
  pullRequest(
    4,
    6271,
    "Bump the checkout SDK to 4.2",
    [
      {
        kind: REVIEW,
        noun: "review request",
        asker: "Noa",
        say: "Noa asked for your review",
        hours: 0.3,
      },
    ],
    "storefront-web",
  ),
  pullRequest(
    5,
    6255,
    "Fix the flaky basket end-to-end test",
    [{ kind: MENTION, noun: "mention", asker: "Kwame", say: "Kwame mentioned you", hours: 5 }],
    "storefront-web",
  ),
  {
    tags: { project: "storefront-web", team: "Checkout" },
    lists: ["waits"],
    thing: {
      ...ticket(6, 0, "", "", [], 1).thing,
      id: buildId(6),
      ref: "sentry:issue:storefront-1z9",
      kind: "sentry/issue",
      noun: "Issue",
      source: "sentry",
      identifier: "STOREFRONT-1Z9",
      title: "TypeError: Cannot read properties of undefined (reading 'deliveryCost')",
      url: "https://sentry.example/storefront-1z9",
      status: { shape: "alert", tone: "bad", label: "Escalating" },
      patience: 12,
      face: {
        place: text("project", "Project", "storefront-web"),
        fact: { key: "events", label: "Events", type: "number", number: 1204 },
      },
      asks: [
        {
          ...buildInboxAsk(buildId(560), "Sentry", {
            kind: REGRESSED,
            noun: "regression",
            createdAt: hoursAgo(1),
          }),
          say: { say: "Came back after a fix", tone: "bad" as const },
        },
      ],
      askCount: 1,
      askKinds: [REGRESSED],
      openKinds: [REGRESSED],
      takenOn: false,
      arrival: 0,
      waitingSince: hoursAgo(1),
      accounts: [buildId(902)],
    },
  },
  ticket(
    7,
    142,
    "Show the delivery cost before the payment step",
    "Checkout revamp",
    ["mine", "with-hercule"],
    2,
    {
      taskId: buildId(800),
      taskTitle: "Show the delivery cost on the basket",
      takenOn: true,
      arrival: 0,
      liveWorkflows: [{ workflowId: buildId(700), name: "Review PR" }],
    },
  ),
  ticket(
    8,
    150,
    "The courier app still calls /wishlist/sync on start",
    "Checkout revamp",
    ["mine"],
    20,
  ),
  ticket(9, 163, "Gift cards: show the balance after payment", "Gift cards", ["updates"], 9),
  ticket(10, 171, "Search relevance: boost exact SKU matches", "Search relevance", ["updates"], 44),
  ticket(11, 178, "Loyalty points: round down on refunds", "Loyalty points", ["updates"], 70),
  // Dismissed a day ago with Theo's review request open; Kwame's mention since brings it back.
  // It is on Everything only, so the list of what waits stays as the other states draw it.
  pullRequest(
    12,
    6230,
    "Drop the unused wishlist endpoints",
    [
      {
        kind: REVIEW,
        noun: "review request",
        asker: "Theo",
        say: "Theo asked for your review",
        hours: 48,
      },
      { kind: MENTION, noun: "mention", asker: "Kwame", say: "Kwame mentioned you", hours: 0.4 },
    ],
    "platform-core",
    { dismissedAt: hoursAgo(24) },
    [],
  ),
];

const ALL_THINGS: ReadonlyArray<InboxThing> = ITEMS.map((item) => item.thing);

/** The saved queries, with the same words the controller's core list has. */
const SAVED_QUERIES: InboxOutline["savedQueries"] = [
  {
    id: CORE_SAVED_QUERY_IDS.waits,
    name: "Someone waits on me",
    order: "waiting",
    signalKinds: [],
    count: 6,
  },
  { id: CORE_SAVED_QUERY_IDS.mine, name: "Mine", order: "newest", signalKinds: [], count: 2 },
  { id: CORE_SAVED_QUERY_IDS.updates, name: "Updates", order: "newest", signalKinds: [], count: 3 },
  {
    id: CORE_SAVED_QUERY_IDS.held,
    name: "With Hercule",
    order: "newest",
    signalKinds: [],
    count: 1,
  },
  {
    id: CORE_SAVED_QUERY_IDS.everything,
    name: "Everything",
    order: "newest",
    signalKinds: [],
    count: ITEMS.length,
  },
  {
    id: "github/review-requests",
    name: "Review requests",
    order: "waiting",
    signalKinds: [],
    source: "github",
    count: 3,
  },
];

const PROJECTS: ReadonlyArray<{
  readonly name: string;
  readonly count: number;
  readonly tone: "good" | "attention" | "bad";
}> = [
  { name: "Checkout revamp", count: 2, tone: "attention" },
  { name: "Payment retries", count: 0, tone: "good" },
  { name: "Winter sale", count: 0, tone: "bad" },
  { name: "Search relevance", count: 1, tone: "good" },
  { name: "Loyalty points", count: 1, tone: "good" },
  { name: "Gift cards", count: 1, tone: "good" },
];

const facet = (
  source: string,
  key: string,
  label: string,
  plural: string,
  values: InboxFacet["values"],
): InboxFacet => ({ source, key, label, plural, values, more: 0 });

/** Builds the outline the rail, the search and the list head read, for the fixture's world. */
export const buildInboxWorldOutline = (): InboxOutline => ({
  savedQueries: SAVED_QUERIES,
  sources: [
    {
      source: "github",
      count: 5,
      folded: false,
      accounts: [],
      facets: [
        facet("github", "repo", "Repository", "Repositories", [
          { value: "storefront-web", label: "storefront-web", count: 4 },
          { value: "platform-core", label: "platform-core", count: 1 },
        ]),
      ],
    },
    {
      source: "tidewatch",
      count: 5,
      folded: false,
      accounts: [],
      facets: [
        facet(
          "tidewatch",
          "project",
          "Project",
          "Projects",
          PROJECTS.map((project) => ({
            value: project.name,
            label: project.name,
            count: project.count,
            health: { shape: "ring", tone: project.tone, label: project.name },
          })),
        ),
      ],
    },
    { source: "sentry", count: 1, folded: true, accounts: [] },
  ],
  pins: [
    {
      source: "tidewatch",
      key: "project",
      value: "Checkout revamp",
      label: "Checkout revamp",
      count: 2,
    },
  ],
  fields: [
    { key: "team", label: "Team", type: "text" },
    { key: "from", label: "From", type: "person" },
    { key: "waiting", label: "Waiting", type: "age" },
    { key: "repo", label: "Repository", type: "text", source: "github" },
    { key: "project", label: "Project", type: "text", source: "tidewatch" },
    { key: "events", label: "Events", type: "number", source: "sentry" },
  ],
  failing: [],
});

/** Returns whether `item` passes one clause of the search or of a Browse scope. */
const passes = (item: Item, clause: NonNullable<InboxQuery["clauses"]>[number]): boolean => {
  if (clause.key === "waiting" && item.thing.waitingSince !== undefined) {
    const seconds = (SPECIMEN_NOW - Date.parse(item.thing.waitingSince)) / 1000;
    const limit = typeof clause.value === "number" ? clause.value : Number(clause.value);
    return clause.op === "over" ? seconds > limit : seconds < limit;
  }
  const tag = item.tags[clause.key as keyof Tags];
  return tag !== undefined && String(clause.value).toLowerCase() === tag.toLowerCase();
};

/** Returns the fixture's items in `list`, as the controller picks them before a search narrows them. */
const pickItems = (list: InboxQuery["list"]): ReadonlyArray<Item> => {
  if ("savedQuery" in list) {
    return list.savedQuery === CORE_SAVED_QUERY_IDS.everything
      ? ITEMS
      : list.savedQuery === "github/review-requests"
        ? ITEMS.filter((item) => item.thing.askKinds.includes(REVIEW))
        : ITEMS.filter((item) => item.lists.includes(list.savedQuery));
  }
  return ITEMS.filter((item) =>
    passes(item, { key: list.browse.key, op: "is", value: list.browse.value }),
  );
};

/**
 * Returns the reply of the mode `query` asks for, from `first`, the one page
 * the fixture holds. The fixture has no second page, so `next` is empty, and
 * every held row it still has is on the first page.
 */
const replyInMode = (query: InboxQuery, first: InboxFirstPage): InboxReply => {
  const { offerSets } = first;
  switch (query.mode) {
    case "first":
      return first;
    case "next":
      return { mode: "next", things: [], offerSets };
    case "refresh":
      return { mode: "refresh", first, held: { things: [], offerSets } };
    case "rows":
      return {
        mode: "rows",
        things: first.things.filter((thing) => query.held.includes(thing.ref)),
        offerSets,
      };
  }
};

/** Returns the reply of a list that holds nothing. */
const answerNothing = (query: InboxQuery): InboxReply =>
  replyInMode(query, {
    mode: "first",
    things: [],
    total: 0,
    order: "newest",
    facets: [],
    offerSets: {},
  });

/** Plays the controller's `queryInbox` over the fixture's things. */
export const answerInboxQuery = (query: InboxQuery): InboxReply => {
  const { list } = query;
  let items = pickItems(list);
  items = items.filter((item) => (query.clauses ?? []).every((clause) => passes(item, clause)));
  const words = (query.text ?? "").trim().toLowerCase();
  if (words !== "") items = items.filter((item) => item.thing.title.toLowerCase().includes(words));
  const isWaiting =
    "browse" in list ||
    list.savedQuery === CORE_SAVED_QUERY_IDS.waits ||
    list.savedQuery === "github/review-requests";
  const ordered = isWaiting
    ? items.toSorted((a, b) =>
        (a.thing.waitingSince ?? "9").localeCompare(b.thing.waitingSince ?? "9"),
      )
    : items.toSorted((a, b) => b.thing.sourceUpdatedAt.localeCompare(a.thing.sourceUpdatedAt));
  const things = ordered.map((item) => item.thing);
  const repos = tally(ordered, "repo");
  const projects = tally(ordered, "project");
  return replyInMode(query, {
    mode: "first",
    things,
    total: things.length,
    order: isWaiting ? "waiting" : "newest",
    offerSets: OFFER_SETS,
    facets: [
      ...(repos.length === 0 ? [] : [facet("github", "repo", "Repository", "Repositories", repos)]),
      ...(projects.length === 0
        ? []
        : [facet("tidewatch", "project", "Project", "Projects", projects)]),
    ],
  });
};

/** Counts the values of the tag `key` among `items`, most common first. */
const tally = (items: ReadonlyArray<Item>, key: keyof Tags): InboxFacet["values"] => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = item.tags[key];
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .toSorted((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, label: value, count }));
};

/** Plays the controller's `suggestInboxValues`: the values of a tag among the list's items, most common first. */
export const answerInboxValues = (query: InboxValueQuery): InboxValues => {
  const prefix = query.prefix.toLowerCase();
  const values = tally(pickItems(query.list), query.key as keyof Tags).filter((value) =>
    value.label.toLowerCase().startsWith(prefix),
  );
  return { values: values.map((value) => ({ ...value, source: "tidewatch" })) };
};

/** Returns the number the fixture gave the thing `id`, which `buildId` made the id from. */
const readItemNumber = (id: string): number => Number(id.slice(-12));

/** Builds what the pane reads for `thing`: its asks as signal lines, and what its extras add. */
export const buildInboxDetail = (thing: InboxThing): ExternalEntityDetail => ({
  id: thing.id,
  ref: thing.ref,
  kind: thing.kind,
  noun: thing.noun,
  card: "compact",
  pace: thing.kind === "github/pull-request" ? "fast" : "slow",
  patience: thing.patience,
  identifier: thing.identifier,
  title: thing.title,
  url: thing.url,
  ...(thing.status === undefined ? {} : { status: thing.status }),
  lifecycle: "open",
  yours: thing.taskId !== undefined,
  facts: [],
  concerns: [],
  access: "ok",
  observedAt: thing.observedAt,
  stale: false,
  sourceUpdatedAt: thing.sourceUpdatedAt,
  firstObservedAt: hoursAgo(72),
  ...(thing.waitingSince === undefined ? {} : { waitingSince: thing.waitingSince }),
  ...(thing.taskId === undefined ? {} : { taskId: thing.taskId }),
  ancestors: [],
  contextComplete: true,
  kindAvailable: true,
  fields: [],
  face: thing.face,
  places: [],
  edges: [],
  links: [],
  hints: [],
  conflicts: [],
  signals: thing.asks.map((ask) => ({
    id: ask.id,
    kind: ask.kind,
    title: ask.say.say,
    ...(ask.asker === undefined ? {} : { asker: ask.asker }),
    priority: "normal" as const,
    status: "open" as const,
    createdAt: ask.createdAt,
    say: ask.say,
    snoozed: false,
    asks: true,
  })),
  openCount: thing.askCount,
  signalCount: thing.askCount,
  timeline: [],
  peers: [],
  offers: OFFER_SETS[thing.offerSetId as keyof typeof OFFER_SETS] ?? [],
  actingConnections: [],
  ...DETAIL_EXTRAS.get(readItemNumber(thing.id)),
});

/** Everything the specimen reads of the Inbox besides the shell's lists. */
export interface InboxRecords {
  readonly outline: InboxOutline;
  /** Answers one page read. `"never"` plays a controller that has not answered yet, which draws the loading shapes. */
  readonly answer: (query: InboxQuery) => InboxReply | "never";
  /** Answers the read of a field's values, which the search offers as it is typed. */
  readonly answerValues: (query: InboxValueQuery) => InboxValues;
  /** What the pane reads for a thing, by id. */
  readonly details: ReadonlyMap<string, ExternalEntityDetail>;
  /** What `signal.read` returns for each ask, by the ask's id. */
  readonly signals: ReadonlyMap<string, Signal>;
  /** What the source shows of a thing, by the thing's id. `"fails"` plays a source that cannot be read. */
  readonly blocks: ReadonlyMap<string, EntityBlocks | "fails">;
  /** Whether the live connection is down, which draws the offline pill. */
  readonly isOffline?: boolean;
  /** The selector of what the page draws last, when that is not a row or an empty state. */
  readonly drawn?: string;
  /** The width of the window to draw at, in pixels, which the capture script sets. The default window when left out. */
  readonly windowWidth?: number;
  /** The width the user gave the pane, which the page keeps in `localStorage`. */
  readonly paneWidth?: number;
}

const DETAILS = new Map(ALL_THINGS.map((thing) => [thing.id, buildInboxDetail(thing)]));

const SIGNALS = new Map(
  ALL_THINGS.flatMap((thing) =>
    thing.asks.map((ask) => [ask.id, buildAskSignal(thing, ask)] as const),
  ),
);

const BLOCKS = new Map(
  ALL_THINGS.flatMap((thing) => {
    const blocks = PANE_BLOCKS.get(readItemNumber(thing.id));
    return blocks === undefined ? [] : [[thing.id, blocks] as const];
  }),
);

/** What the page does after it draws: presses what a user would press. */
type Play = (page: Document) => Promise<void>;

/** One state of the Inbox page, picked by `?state=`. */
export interface InboxScene {
  readonly name: string;
  readonly records: InboxRecords;
  readonly play?: Play;
}

const BASE: InboxRecords = {
  outline: buildInboxWorldOutline(),
  answer: answerInboxQuery,
  answerValues: answerInboxValues,
  details: DETAILS,
  signals: SIGNALS,
  blocks: BLOCKS,
};

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Waits for `selector` to match, for up to five seconds, and returns the element. */
const waitFor = async (page: Document, selector: string): Promise<HTMLElement> => {
  const deadline = performance.now() + 5000;
  let found = page.querySelector<HTMLElement>(selector);
  while (found === null && performance.now() < deadline) {
    await nextFrame();
    found = page.querySelector<HTMLElement>(selector);
  }
  if (found === null) throw new Error(`The Inbox page never drew ${selector}.`);
  return found;
};

/** Types `words` into the search field as a user would, one input event with the whole text. */
const typeSearch = async (page: Document, words: string): Promise<void> => {
  const input = await waitFor(page, ".ib-sx input");
  if (!(input instanceof HTMLInputElement)) throw new Error("The search field is not an input.");
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, words);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextFrame();
};

/** Returns the first element that matches `selector` and holds `words`, or `undefined`. */
const findByText = (page: Document, selector: string, words: string): HTMLElement | undefined =>
  [...page.querySelectorAll<HTMLElement>(selector)].find((each) =>
    (each.textContent ?? "").includes(words),
  );

/** Presses the row of the list that holds `words`, as a click does, so the pane opens its thing. */
const openRow = async (page: Document, words: string): Promise<void> => {
  const deadline = performance.now() + 5000;
  let row = findByText(page, ".ib-row", words);
  while (row === undefined && performance.now() < deadline) {
    await nextFrame();
    row = findByText(page, ".ib-row", words);
  }
  if (row === undefined) throw new Error(`The list has no row with "${words}".`);
  row.click();
  await waitFor(page, ".ib-pane-title");
};

/** Presses the item of the rail whose name holds `words`, and waits for the list it opens. */
const openRailItem = async (page: Document, words: string): Promise<void> => {
  await waitFor(page, "[data-rail-item]");
  const item = findByText(page, "[data-rail-item]", words);
  if (item === undefined) throw new Error(`The rail has no item with "${words}".`);
  item.click();
  await waitFor(page, ".ib-row");
};

/**
 * Waits until the pane has read what it draws for the open thing: the answers
 * of its current ask and, with `hasBlocks`, what its source shows of it
 * (blocks, or the line that says they could not be read).
 */
const settlePane = async (page: Document, hasBlocks = true): Promise<void> => {
  await waitFor(page, ".sig.is-open .sig-answers");
  if (hasBlocks) await waitFor(page, ".ib-pane-blocks:not(.ib-pane-blocks-skel)");
};

/** Opens pull request #6244, the thing the drawing's pane is drawn for, and waits for the whole pane. */
const openPullRequest: Play = async (page) => {
  await openRow(page, "#6244");
  await settlePane(page);
};

/** The states of the page, in the order the capture takes them. */
export const INBOX_SCENES: ReadonlyArray<InboxScene> = [
  { name: "waits", records: BASE, play: openPullRequest },
  {
    name: "browse",
    records: BASE,
    play: async (page) => {
      await waitFor(page, ".ib-rail-value");
      const row = [...page.querySelectorAll<HTMLElement>(".ib-rail-value")].find((each) =>
        (each.textContent ?? "").includes("Checkout revamp"),
      );
      if (row === undefined) throw new Error("The rail lists no Checkout revamp.");
      row.click();
      await waitFor(page, ".ib-row");
    },
  },
  {
    name: "search",
    records: BASE,
    play: async (page) => {
      await waitFor(page, ".ib-row");
      await typeSearch(page, "team:Checkout waiting:>2h team:");
      // The field keeps the focus, with the values of the open clause offered under it.
      await waitFor(page, '[role="option"]');
    },
  },
  {
    name: "empty",
    records: {
      ...BASE,
      answer: (query) =>
        "savedQuery" in query.list && query.list.savedQuery === CORE_SAVED_QUERY_IDS.waits
          ? answerNothing(query)
          : answerInboxQuery(query),
      outline: {
        ...BASE.outline,
        savedQueries: SAVED_QUERIES.map((query) =>
          query.id === CORE_SAVED_QUERY_IDS.waits ? { ...query, count: 0 } : query,
        ),
      },
    },
  },
  {
    name: "zero",
    records: {
      ...BASE,
      answer: answerNothing,
      outline: {
        ...BASE.outline,
        savedQueries: SAVED_QUERIES.map((query) => ({ ...query, count: 0 })),
        sources: [],
        pins: [],
      },
    },
  },
  { name: "loading", records: { ...BASE, answer: () => "never", drawn: ".ib-skel" } },
  { name: "offline", records: { ...BASE, isOffline: true } },
  {
    name: "failing",
    records: {
      ...BASE,
      outline: { ...BASE.outline, failing: [{ source: "github", updatedAt: hoursAgo(1) }] },
    },
  },
  {
    name: "selection",
    records: BASE,
    play: async (page) => {
      await waitFor(page, ".ib-row");
      for (const tick of [...page.querySelectorAll<HTMLElement>(".ib-row-tick")].slice(1, 4)) {
        tick.click();
        await nextFrame();
      }
      await waitFor(page, ".ib-pane-members");
    },
  },
  { name: "narrow", records: { ...BASE, paneWidth: 360 }, play: openPullRequest },
  { name: "pane-440", records: { ...BASE, paneWidth: 440 }, play: openPullRequest },
  {
    name: "narrow-menu",
    records: BASE,
    play: async (page) => {
      (await waitFor(page, "button.ib-narrow")).click();
      await waitFor(page, ".ib-narrow-heading");
    },
  },
  { name: "width-1280", records: { ...BASE, windowWidth: 1280 }, play: openPullRequest },
  { name: "width-1024", records: { ...BASE, windowWidth: 1024 }, play: openPullRequest },
  { name: "stacked-880", records: { ...BASE, windowWidth: 880 } },
  {
    // The source cannot be read: the pane draws one quiet line where its blocks would be.
    name: "blocks-failed",
    records: { ...BASE, blocks: new Map([[buildId(1), "fails" as const]]) },
    play: async (page) => {
      await openRow(page, "#6244");
      await waitFor(page, ".ib-pane-blocks-note");
    },
  },
  {
    // A Sentry issue: one ask, and a trend, fields and a stack trace for blocks.
    name: "sentry",
    records: BASE,
    play: async (page) => {
      await openRow(page, "STOREFRONT-1Z9");
      await settlePane(page);
    },
  },
  {
    // The second ask unfolded, which makes it the current one.
    name: "second-ask",
    records: BASE,
    play: async (page) => {
      await openPullRequest(page);
      const head = findByText(page, ".sig-head", "Mei");
      if (head === undefined) throw new Error("The pane has no ask from Mei.");
      head.click();
      await waitFor(page, ".sig.is-open.is-current-ask [data-answer=approve]");
    },
  },
  {
    // A reply box open, with words typed that the draft keeps.
    name: "reply",
    records: BASE,
    play: async (page) => {
      await openPullRequest(page);
      (await waitFor(page, "[data-answer=reply]")).click();
      const box = await waitFor(page, ".sig-reply textarea");
      if (!(box instanceof HTMLTextAreaElement))
        throw new Error("The reply box is not a textarea.");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        box,
        "Yes. Finance asked for the invoice's rounding, so I'll move it after VAT today.",
      );
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await nextFrame();
    },
  },
  {
    // An answer that acts on the source, pressed and held: the undo line says when it is sent.
    name: "held",
    records: BASE,
    play: async (page) => {
      await openRow(page, "#6213");
      await settlePane(page);
      (await waitFor(page, "[data-answer=approve]")).click();
      await waitFor(page, ".undo-text, .side-toast-text");
      // The pane moved on to the next thing and took the focus with it; a pointer press shows no ring.
      if (page.activeElement instanceof HTMLElement) page.activeElement.blur();
    },
  },
  {
    // A thing someone has: the strip under its meta line says who, and goes to the Task.
    name: "holder",
    records: BASE,
    play: async (page) => {
      await openRailItem(page, "With Hercule");
      await waitFor(page, ".ib-pane-held");
      await waitFor(page, ".ib-pane-blocks:not(.ib-pane-blocks-skel)");
    },
  },
  {
    // A thing that came back after a dismissal: the meta line says what brought it back.
    name: "returned",
    records: BASE,
    play: async (page) => {
      await openRailItem(page, "Everything");
      await openRow(page, "#6230");
      await waitFor(page, ".sig.is-open .sig-answers");
    },
  },
];

const connect = (id: string, type: string, label: string): Connection => ({
  id,
  type,
  label,
  displayName: label,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: hoursAgo(24 * 40),
  updatedAt: hoursAgo(24 * 40),
});

const PLUGINS: ReadonlyArray<PluginDetail> = [
  GITHUB_PLUGIN,
  TIDEWATCH_PLUGIN,
  buildPlugin("sentry", "Sentry", SENTRY_MARK),
];

/** The sidebar's lists with the three plugins and their Connections, for a specimen that opens the Inbox. */
export const INBOX_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  plugins: PLUGINS,
  connections: [
    connect(buildId(900), "github/github", "acme"),
    connect(buildId(901), "tidewatch/tidewatch", "shop"),
    connect(buildId(902), "sentry/sentry", "northwind"),
  ],
};
