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
  ExternalEntityDetail,
  InboxCounts,
  InboxFacet,
  InboxPage,
  InboxQuery,
  InboxThing,
  PluginDetail,
} from "@hercule/contract";
import { buildInboxAsk, buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import { buildPlugin, GITHUB_PLUGIN, SENTRY_MARK, TIDEWATCH_PLUGIN } from "./plugins-fixture";
import type { SidebarRecords } from "./shell-page";

const HOUR_MS = 3_600_000;

/** Returns the moment `hours` hours before the specimen's clock, as an ISO timestamp. */
const hoursAgo = (hours: number): string => new Date(SPECIMEN_NOW - hours * HOUR_MS).toISOString();

const buildId = (n: number): string => `01a2f000-0000-7000-8000-${String(n).padStart(12, "0")}`;

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

const REVIEW = "github/review-requested";
const MENTION = "github/mentioned";
const REGRESSED = "sentry/regressed";

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
    lifecycle: "open",
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
    lifecycle: "open",
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
];

const ALL_THINGS: ReadonlyArray<InboxThing> = ITEMS.map((item) => item.thing);

/** The saved queries, with the same words the controller's core list has. */
const SAVED_QUERIES: InboxCounts["savedQueries"] = [
  { id: "waits", name: "Someone waits on me", order: "waiting", count: 6 },
  { id: "mine", name: "Mine", order: "newest", count: 2 },
  { id: "updates", name: "Updates", order: "newest", count: 3 },
  { id: "with-hercule", name: "With Hercule", order: "newest", count: 1 },
  { id: "everything", name: "Everything", order: "newest", count: ITEMS.length },
  {
    id: "github/review-requests",
    name: "Review requests",
    order: "waiting",
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

/** Builds the counts the sidebar and the rail read, for the fixture's world. */
export const buildInboxWorldCounts = (): InboxCounts => ({
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
  newestArrival: 0,
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

/** Plays the controller's `queryInbox` over the fixture's things. */
export const answerInboxQuery = (query: InboxQuery): InboxPage => {
  const { list } = query;
  let items: ReadonlyArray<Item>;
  if ("savedQuery" in list) {
    items =
      list.savedQuery === "everything"
        ? ITEMS
        : list.savedQuery === "github/review-requests"
          ? ITEMS.filter((item) => item.thing.askKinds.includes(REVIEW))
          : ITEMS.filter((item) => item.lists.includes(list.savedQuery));
  } else {
    items = ITEMS.filter((item) => passes(item, list.browse));
  }
  items = items.filter((item) => (query.clauses ?? []).every((clause) => passes(item, clause)));
  const words = (query.text ?? "").trim().toLowerCase();
  if (words !== "") items = items.filter((item) => item.thing.title.toLowerCase().includes(words));
  const isWaiting =
    "browse" in list || list.savedQuery === "waits" || list.savedQuery === "github/review-requests";
  const ordered = isWaiting
    ? items.toSorted((a, b) =>
        (a.thing.waitingSince ?? "9").localeCompare(b.thing.waitingSince ?? "9"),
      )
    : items.toSorted((a, b) => b.thing.sourceUpdatedAt.localeCompare(a.thing.sourceUpdatedAt));
  const things = ordered.map((item) => item.thing);
  const repos = tally(ordered, "repo");
  const projects = tally(ordered, "project");
  return {
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
  };
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

/** Builds what the pane reads for `thing`: a plain detail with no signals. */
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
  signals: [],
  openCount: thing.askCount,
  signalCount: thing.askCount,
  timeline: [],
  peers: [],
  offers: OFFER_SETS[thing.offerSetId as keyof typeof OFFER_SETS] ?? [],
  actingConnections: [],
});

/** Everything the specimen reads of the Inbox besides the shell's lists. */
export interface InboxRecords {
  readonly counts: InboxCounts;
  /** Answers one page read. `"never"` plays a controller that has not answered yet, which draws the loading shapes. */
  readonly answer: (query: InboxQuery) => InboxPage | "never";
  /** What the pane reads for a thing, by id. */
  readonly details: ReadonlyMap<string, ExternalEntityDetail>;
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

const NO_THINGS: InboxPage = { things: [], total: 0, order: "newest", offerSets: {} };

/** What the page does after it draws: presses what a user would press. */
type Play = (page: Document) => Promise<void>;

/** One state of the Inbox page, picked by `?state=`. */
export interface InboxScene {
  readonly name: string;
  readonly records: InboxRecords;
  readonly play?: Play;
}

const BASE: InboxRecords = {
  counts: buildInboxWorldCounts(),
  answer: answerInboxQuery,
  details: DETAILS,
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

/** The states of the page, in the order the capture takes them. */
export const INBOX_SCENES: ReadonlyArray<InboxScene> = [
  { name: "waits", records: BASE },
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
      await typeSearch(page, "team:Checkout waiting:>2h ");
      // The field gives the results the room, as a user's Return would.
      (page.activeElement as HTMLElement | null)?.blur();
      await nextFrame();
    },
  },
  {
    name: "empty",
    records: {
      ...BASE,
      answer: (query) =>
        "savedQuery" in query.list && query.list.savedQuery === "waits"
          ? NO_THINGS
          : answerInboxQuery(query),
      counts: {
        ...BASE.counts,
        savedQueries: SAVED_QUERIES.map((query) =>
          query.id === "waits" ? { ...query, count: 0 } : query,
        ),
      },
    },
  },
  {
    name: "zero",
    records: {
      ...BASE,
      answer: () => NO_THINGS,
      counts: {
        ...BASE.counts,
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
      counts: { ...BASE.counts, failing: [{ source: "github", since: hoursAgo(1) }] },
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
    },
  },
  { name: "narrow", records: { ...BASE, paneWidth: 360 } },
  {
    name: "narrow-menu",
    records: BASE,
    play: async (page) => {
      (await waitFor(page, "button.ib-narrow")).click();
      await waitFor(page, ".ib-narrow-heading");
    },
  },
  { name: "width-1280", records: { ...BASE, windowWidth: 1280 } },
  { name: "width-1024", records: { ...BASE, windowWidth: 1024 } },
  { name: "stacked-880", records: { ...BASE, windowWidth: 880 } },
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
