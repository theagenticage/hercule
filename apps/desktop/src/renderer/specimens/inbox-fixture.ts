/**
 * The records of the Inbox specimen (inbox.tsx): an Inbox of the invented
 * Northwind Market world, as `externalEntity.queryInbox` would return it at the
 * specimen's clock, Tuesday 29 September 2026, 09:41 UTC.
 *
 * Two plugins feed it: GitHub, whose pull requests lie in Requests and whose
 * issues lie under Ongoing on the surface of their repository, and the
 * invented Quayside, whose purchase orders lie on the surface of their
 * delivery round, with the round's status, its reported progress, its target
 * date and the site it is part of.
 *
 * - Ongoing: three surfaces. Storefront web holds issues, one of them under a
 *   second repository too (a pointer there), one with facts that may be old, and
 *   one with a very long title. Two delivery rounds hold orders, one held.
 * - Requests: nine pull requests of every wait, from hours to days, with a
 *   usual reason, a reason with a tone, a status that is not the usual one, and
 *   one of the user's own.
 * - With someone else: two pull requests that have a Task.
 * - Links: one issue carries a pull request that rides on it (an asking part), a
 *   pull request that has no card of its own (a quiet part) and a Sentry issue
 *   nobody here can read (a locked part), and says how long ago its latest
 *   signal landed. A pull request that mentions another issue in its text shows
 *   a hint, and one that is linked to a pull request with no card says so.
 */
import type {
  Connection,
  EntityEdge,
  EntityLink,
  EntityPeer,
  EntityPlace,
  Inbox,
  InboxCard,
  PluginDetail,
} from "@hercule/contract";
import { buildInbox, buildInboxCard, buildRequestCard } from "@hercule/client-core/inbox/testing";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import { GITHUB_PLUGIN, QUAYSIDE_PLUGIN } from "./plugins-fixture";
import type { SidebarRecords } from "./shell-page";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Returns the moment `hours` hours before the specimen's clock, as an ISO timestamp. */
const hoursAgo = (hours: number): string => new Date(SPECIMEN_NOW - hours * HOUR_MS).toISOString();

/** Returns the moment `days` days before the specimen's clock, as an ISO timestamp. */
const daysAgo = (days: number): string => new Date(SPECIMEN_NOW - days * DAY_MS).toISOString();

const WEB = "github:repository:acme/storefront-web";
const CORE = "github:repository:acme/platform-core";
const SITE = "quayside:site:rotterdam";
const WINTER = "quayside:round:winter-stock";
const RETURNS = "quayside:round:returns";

const repository = (ref: string, title: string): EntityPlace => ({
  ref,
  kind: "github/repository",
  noun: "Repository",
  caption: "GitHub repository",
  title,
  restricted: false,
});

const round = (ref: string, title: string, overrides: Partial<EntityPlace>): EntityPlace => ({
  ref,
  kind: "quayside/round",
  noun: "Delivery round",
  caption: "Quayside delivery round",
  title,
  restricted: false,
  ...overrides,
});

const PLACES: readonly EntityPlace[] = [
  repository(WEB, "storefront-web"),
  repository(CORE, "platform-core"),
  {
    ref: SITE,
    kind: "quayside/site",
    noun: "Site",
    caption: "Quayside site",
    title: "Rotterdam depot",
    restricted: false,
  },
  round(WINTER, "Winter stock", {
    status: { shape: "half", tone: "active", label: "Receiving" },
    progress: { fraction: 3 / 5, done: 3, total: 5 },
    targetDate: "2026-10-21T00:00:00.000Z",
  }),
  round(RETURNS, "Returns at the depot", {
    status: { shape: "check", tone: "good", label: "On track" },
    progress: { fraction: 8 / 13, done: 8, total: 13 },
    targetDate: "2026-11-28T00:00:00.000Z",
  }),
];

const issue = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildInboxCard(`${n}`, {
    ref: `github:issue:acme/storefront-web#${String(n)}`,
    kind: "github/issue",
    noun: "Issue",
    home: "github/repository",
    pace: "slow",
    patience: 336,
    identifier: `#${String(n)}`,
    title,
    status: { shape: "ring", tone: "quiet", label: "Open" },
    yours: true,
    ancestors: [WEB],
    firstObservedAt: daysAgo(20 - n / 100),
    ...overrides,
  });

const order = (
  n: number,
  title: string,
  roundRef: string,
  overrides: Partial<InboxCard> = {},
): InboxCard =>
  buildInboxCard(`${n}`, {
    ref: `quayside:order:PO-${String(n)}`,
    kind: "quayside/purchase-order",
    noun: "Purchase order",
    home: "quayside/round",
    section: "quayside/site",
    pace: "slow",
    patience: 120,
    identifier: `PO-${String(n)}`,
    title,
    status: { shape: "ring", tone: "quiet", label: "Sign-off" },
    yours: true,
    ancestors: [roundRef, SITE],
    firstObservedAt: daysAgo(9 - n / 10000),
    ...overrides,
  });

const review = (
  n: number,
  title: string,
  waitingHours: number,
  overrides: Partial<InboxCard> = {},
): InboxCard =>
  buildRequestCard(`${n}`, {
    ref: `github:pull-request:acme/storefront-web#${String(n)}`,
    kind: "github/pull-request",
    noun: "Pull request",
    home: "github/repository",
    patience: 24,
    identifier: `#${String(n)}`,
    title,
    status: { shape: "fork", tone: "active", label: "Open", norm: true },
    person: { name: "Ines" },
    reason: { say: "Ines asked for your review", tone: "plain" },
    ancestors: [WEB],
    waitingSince: hoursAgo(waitingHours),
    firstObservedAt: hoursAgo(waitingHours + 1),
    ...overrides,
  });

const ISSUE_412 = "github:issue:acme/storefront-web#412";
const ISSUE_398 = "github:issue:acme/storefront-web#398";

const CARDS: readonly InboxCard[] = [
  // Ongoing: Storefront web.
  issue(412, "Basket total rounds the wrong way on multi-buy offers", {
    person: { name: "Tessa" },
    yours: false,
    facts: [{ form: "bars", level: 3 }],
    reason: { say: "Tessa commented", tone: "plain" },
    signals: {
      openCount: 2,
      latest: {
        id: "01a0d1c0-6e80-7000-8000-000000000a01",
        kind: "github/commented",
        title: "Tessa commented",
        asker: "Tessa",
        priority: "normal",
        status: "open",
        createdAt: hoursAgo(26),
        say: { say: "Tessa commented", tone: "plain" },
        snoozed: false,
      },
    },
  }),
  issue(398, "Keep card numbers out of the gateway debug log", {
    status: { shape: "half", tone: "active", label: "In progress" },
    ancestors: [WEB, CORE],
  }),
  issue(
    377,
    "Search feed drops unbranded products after the catalogue import, so shoppers see an empty page",
    {
      status: { shape: "alert", tone: "attention", label: "Needs triage" },
      person: { name: "Wren" },
      yours: false,
      stale: true,
      observedAt: daysAgo(3),
    },
  ),
  // Ongoing: Platform core.
  issue(1204, "Retry card payments once on a gateway timeout", {
    ref: "github:issue:acme/platform-core#1204",
    ancestors: [CORE],
    status: { shape: "dashed", tone: "quiet", label: "Draft" },
  }),
  // Ongoing: two delivery rounds.
  order(2291, "Chilled crates for the Rotterdam depot", WINTER, {
    facts: [
      { form: "money", text: "€4,120" },
      { form: "date", on: "2026-10-02T00:00:00.000Z" },
    ],
  }),
  order(2304, "Spare scanners for returns", WINTER, {
    status: { shape: "hold", tone: "attention", label: "Held" },
    facts: [{ form: "money", text: "€860" }],
    reason: { say: "Delivery moved to Monday", tone: "attention" },
  }),
  order(2310, "Pallet wrap for the returns bay", RETURNS, {
    facts: [{ form: "money", text: "€240" }],
  }),
  // Requests.
  review(6241, "Cache delivery slot lookups for five minutes", 120, { person: { name: "Juno" } }),
  review(
    6238,
    "Split the basket summary into smaller components so that the delivery estimate loads first",
    118,
    {
      person: { name: "Felix" },
      ridesOn: ISSUE_412,
    },
  ),
  review(6230, "Show unit prices on multi-buy offers", 100, {
    status: { shape: "fork", tone: "attention", label: "Changes requested" },
    person: { name: "Felix" },
    reason: { say: "Felix asked again", tone: "attention" },
  }),
  review(6221, "Move the order schema to the shared package", 27, { person: { name: "Tessa" } }),
  review(6219, "Drop the unused wishlist endpoints", 25, { person: { name: "Theo" } }),
  review(6207, "Move promo banner copy into the content tool", 10, { person: { name: "Wren" } }),
  review(6203, "Add a loading state to the address finder", 9, {
    person: { name: "Theo" },
    reason: { say: "Theo approved it", tone: "good" },
  }),
  review(6198, "Round loyalty points down at checkout", 8, {
    yours: true,
    person: { name: "Noa" },
    status: { shape: "cross", tone: "bad", label: "Checks failed" },
    reason: { say: "Checks failed", tone: "bad" },
  }),
  review(6190, "Log the reason when a coupon is refused", 2, { person: { name: "Ines" } }),
  // With someone else.
  review(6180, "Stop sending duplicate order emails", 30, {
    side: "with-someone-else",
    taskId: "01a0d1c0-6e80-7000-8000-000000000901",
    person: { name: "Tessa" },
  }),
  review(6176, "Upgrade the image resizer", 52, {
    side: "with-someone-else",
    taskId: "01a0d1c0-6e80-7000-8000-000000000902",
    person: { name: "Juno" },
  }),
];

/**
 * The `part of` edges of the specimen: each delivery round is part of its
 * site, and each card is part of the places nearest to it, which are all of
 * its ancestors except the site (a round already reaches the site).
 */
const EDGES: readonly EntityEdge[] = [
  { fromRef: WINTER, toRef: SITE },
  { fromRef: RETURNS, toRef: SITE },
  ...CARDS.flatMap((card) =>
    card.ancestors.filter((ref) => ref !== SITE).map((toRef) => ({ fromRef: card.ref, toRef })),
  ),
];

const pullRequestRef = (n: number): string =>
  `github:pull-request:acme/storefront-web#${String(n)}`;

/** Pull requests with no card of their own, and a Sentry issue nobody here can read: what the links reach that is not on the page. */
const PEERS: readonly EntityPeer[] = [
  {
    ref: pullRequestRef(6101),
    kind: "github/pull-request",
    noun: "Pull request",
    identifier: "#6101",
    title: "Round multi-buy totals in the basket summary",
    status: { shape: "join", tone: "good", label: "Merged" },
    yours: true,
    restricted: false,
  },
  {
    ref: pullRequestRef(6100),
    kind: "github/pull-request",
    noun: "Pull request",
    identifier: "#6100",
    title: "Add the promo banner slot",
    yours: false,
    restricted: false,
  },
  {
    ref: "sentry:issue:4471",
    kind: "sentry/issue",
    noun: "Issue",
    yours: false,
    restricted: true,
  },
];

/** The claims between the specimen's things: a source's, a person's and a reference found in text. */
const LINKS: readonly EntityLink[] = [
  { fromRef: ISSUE_412, toRef: pullRequestRef(6238), claim: { type: "source", plugin: "github" } },
  { fromRef: ISSUE_412, toRef: pullRequestRef(6101), claim: { type: "person", actor: "user" } },
  { fromRef: ISSUE_412, toRef: "sentry:issue:4471", claim: { type: "source", plugin: "github" } },
  {
    fromRef: pullRequestRef(6219),
    toRef: ISSUE_398,
    claim: { type: "text", evidenceKey: "description" },
  },
  {
    fromRef: pullRequestRef(6207),
    toRef: pullRequestRef(6100),
    claim: { type: "source", plugin: "github" },
  },
];

/** What `externalEntity.queryInbox` answers in the specimen. */
export const INBOX: Inbox = {
  ...buildInbox(CARDS, { places: PLACES, edges: EDGES, links: LINKS, peers: PEERS }),
  counts: { onTheClock: 9, requests: 9, withSomeoneElse: 2, newestArrival: 9 },
};

/** A kind of External Entity a plugin declares, qualified with the plugin's id. */
type EntityKind = PluginDetail["entityKinds"][number];

/**
 * Returns a kind a plugin declares, with the words the Inbox needs: its card
 * size, its pace, and what first run says it brings. The rest is a plain kind.
 */
const kind = (word: string, noun: string, overrides: Partial<EntityKind>): EntityKind => ({
  word,
  noun,
  refPrefix: `${word.replace("/", ":")}:`,
  pace: "slow",
  patience: 336,
  identifier: "#{number}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
  ...overrides,
});

/** The plugins the Inbox specimen installs, with the kinds they declare. */
const PLUGINS: readonly PluginDetail[] = [
  {
    ...GITHUB_PLUGIN,
    entityKinds: [
      kind("github/pull-request", "Pull request", {
        card: "compact",
        pace: "fast",
        patience: 24,
        connect: "Reviews people ask of you",
      }),
      kind("github/issue", "Issue", { connect: "Issues assigned to you" }),
      kind("github/repository", "Repository", { pace: "context" }),
    ],
  },
  {
    ...QUAYSIDE_PLUGIN,
    entityKinds: [
      kind("quayside/purchase-order", "Purchase order", {
        identifier: "PO-{number}",
        connect: "Orders waiting for your sign-off",
      }),
      kind("quayside/round", "Delivery round", { pace: "context" }),
      kind("quayside/site", "Site", { pace: "context" }),
    ],
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
  createdAt: daysAgo(40),
  updatedAt: daysAgo(40),
});

/** The sidebar's lists with the two plugins and their Connections added, for a specimen that opens the Inbox. */
export const INBOX_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  plugins: PLUGINS,
  connections: [
    connect("c-github", "github/github", "acme"),
    connect("c-quayside", "quayside/quayside", "rotterdam"),
  ],
};
