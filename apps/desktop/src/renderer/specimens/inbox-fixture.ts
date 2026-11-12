/**
 * The records of the Inbox specimen (inbox.tsx): an Inbox of the invented
 * Northwind Market world, as `externalEntity.queryInbox` would return it at the
 * specimen's clock, Tuesday 29 September 2026, 09:41 UTC.
 *
 * Three plugins feed it: GitHub, whose pull requests lie in Requests and whose
 * issues lie under Ongoing on the surface of their repository, the invented
 * Quayside, whose purchase orders lie on the surface of their delivery round,
 * with the round's status, its reported progress, its target date and the
 * site it is part of, and the invented Tidewatch, a planning tracker whose
 * tickets lie on the surface of their project, in the section of their
 * milestone.
 *
 * - Ongoing: three surfaces. Storefront web holds issues, one of them under a
 *   second repository too (a pointer there), one with facts that may be old, and
 *   one with a very long title. Two delivery rounds hold orders, one held.
 * - Requests: nine pull requests of every wait, from hours to days, with a
 *   usual reason, a reason with a tone, a status that is not the usual one, and
 *   one of the user's own.
 * - With someone else: two pull requests that have a Task.
 * - Tidewatch: three tickets under the Checkout revamp project (at risk, with
 *   its progress and its target date) in two milestones, one ticket in none, and
 *   a pull request that rides on the first ticket because Tidewatch reports it.
 *   The first ticket is the one the open card specimen opens: it has a resolved
 *   and an open signal, two changes at the source, and a hint from a pull request.
 * - Links: one issue carries a pull request that rides on it (an asking part), a
 *   pull request that has no card of its own (a quiet part) and a Sentry issue
 *   nobody here can read (a locked part), and says how long ago its latest
 *   signal landed. A pull request that mentions another issue in its text shows
 *   a hint, and one that is linked to a pull request with no card says so.
 */
import type {
  ActingConnection,
  Connection,
  EntityChange,
  EntityEdge,
  EntityHint,
  EntityLink,
  EntityPeer,
  EntityPlace,
  EntitySignalLine,
  ExternalEntityDetail,
  Inbox,
  InboxCard,
  PluginDetail,
  Signal,
  WorkflowOffer,
} from "@hercule/contract";
import {
  buildInbox,
  buildInboxCard,
  buildRequestCard,
  buildWorkflowOffer,
} from "@hercule/client-core/inbox/testing";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import { GITHUB_PLUGIN, QUAYSIDE_PLUGIN, TIDEWATCH_PLUGIN } from "./plugins-fixture";
import type { InboxOpenCardRecords, SidebarRecords } from "./shell-page";

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
const CHECKOUT = "tidewatch:project:checkout-revamp";
const BETA = "tidewatch:milestone:beta";
const LAUNCH = "tidewatch:milestone:launch";
const CONNECTION_TIDEWATCH = "c-tidewatch";
const CONNECTION_GITHUB = "c-github";
const CONNECTION_GITHUB_BOT = "c-github-bot";

const ACCOUNT_GITHUB: ActingConnection = { id: CONNECTION_GITHUB, label: "acme" };
const ACCOUNT_GITHUB_BOT: ActingConnection = { id: CONNECTION_GITHUB_BOT, label: "northwind-bot" };
const ACCOUNT_TIDEWATCH: ActingConnection = { id: CONNECTION_TIDEWATCH, label: "shop" };

/**
 * The workflows each kind of card can be handed to, by offer set id, as
 * `externalEntity.queryInbox` groups them:
 *
 * - pull requests: one available workflow, so the move on hover is named after it;
 * - issues: two available workflows (a menu), and two that cannot take the
 *   card, with their reasons;
 * - tickets: one available workflow, and one whose `signal` input has to
 *   change before it can take a card;
 * - purchase orders: no account can act on them, so the one workflow is
 *   unavailable and the card offers no hand-off.
 */
const OFFER_SETS: Readonly<Record<string, readonly WorkflowOffer[]>> = {
  "github/pull-request": [buildWorkflowOffer("Agent review", ["github/review-requested"])],
  "github/issue": [
    buildWorkflowOffer("Triage", ["github/commented", "github/assigned"]),
    buildWorkflowOffer("Fix it", ["github/assigned"]),
    buildWorkflowOffer("Draft the change", [], {
      reason: "repository",
      message: "Works on acme/platform-core only.",
    }),
    buildWorkflowOffer("Check the release", [], {
      reason: "needs-input",
      message: "Asks for a release tag the Inbox cannot fill.",
    }),
  ],
  "tidewatch/ticket": [
    buildWorkflowOffer("Plan the work", ["tidewatch/commented", "tidewatch/assigned"]),
    buildWorkflowOffer("Size the ticket", [], {
      reason: "needs-workflow-change",
      message: "Takes a signal, not a card. Give it an entity input.",
    }),
  ],
  "quayside/purchase-order": [
    buildWorkflowOffer("Chase the supplier", [], {
      reason: "no-account",
      message: "No connected account can act on this.",
    }),
  ],
};

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
  {
    ref: CHECKOUT,
    kind: "tidewatch/project",
    noun: "Project",
    caption: "Tidewatch project",
    title: "Checkout revamp",
    status: { shape: "hold", tone: "attention", label: "At risk" },
    progress: { fraction: 9 / 20, done: 9, total: 20 },
    targetDate: "2026-10-30T00:00:00.000Z",
    restricted: false,
  },
  {
    ref: BETA,
    kind: "tidewatch/milestone",
    noun: "Milestone",
    caption: "Tidewatch milestone",
    title: "Beta",
    progress: { fraction: 0.5 },
    targetDate: "2026-10-14T00:00:00.000Z",
    restricted: false,
  },
  {
    ref: LAUNCH,
    kind: "tidewatch/milestone",
    noun: "Milestone",
    caption: "Tidewatch milestone",
    title: "Launch",
    targetDate: "2026-10-30T00:00:00.000Z",
    restricted: false,
  },
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
    offerSetId: "github/issue",
    actingConnections: [ACCOUNT_GITHUB],
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
    offerSetId: "quayside/purchase-order",
    ...overrides,
  });

const ticket = (
  n: number,
  title: string,
  milestoneRef: string | undefined,
  overrides: Partial<InboxCard> = {},
): InboxCard =>
  buildInboxCard(`${n}`, {
    ref: `tidewatch:ticket:SHOP-${String(n)}`,
    kind: "tidewatch/ticket",
    noun: "Ticket",
    home: "tidewatch/project",
    section: "tidewatch/milestone",
    pace: "slow",
    patience: 336,
    identifier: `SHOP-${String(n)}`,
    title,
    status: { shape: "ring", tone: "quiet", label: "Todo" },
    yours: true,
    ancestors: milestoneRef === undefined ? [CHECKOUT] : [milestoneRef, CHECKOUT],
    firstObservedAt: daysAgo(12 - n / 1000),
    offerSetId: "tidewatch/ticket",
    actingConnections: [ACCOUNT_TIDEWATCH],
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
    offerSetId: "github/pull-request",
    actingConnections: [ACCOUNT_GITHUB],
    ...overrides,
  });

const ISSUE_412 = "github:issue:acme/storefront-web#412";
const ISSUE_398 = "github:issue:acme/storefront-web#398";
const TICKET_142 = "tidewatch:ticket:SHOP-142";
const TICKET_150 = "tidewatch:ticket:SHOP-150";
const TICKET_142_ID = "142";
/** The signal the open card specimen opens: Mei's comment on the first ticket. */
const COMMENT_SIGNAL_ID = "01a0d1c0-6e80-7000-8000-000000000b02";
const EARLIER_SIGNAL_ID = "01a0d1c0-6e80-7000-8000-000000000b01";

/** The signal lines of the first ticket, oldest first: an earlier one answered, and Mei's comment open. */
const TICKET_142_SIGNALS: readonly EntitySignalLine[] = [
  {
    id: EARLIER_SIGNAL_ID,
    kind: "tidewatch/assigned",
    title: "Assigned to you",
    asker: "Noa",
    priority: "normal",
    status: "resolved",
    createdAt: daysAgo(4),
    say: { say: "Noa assigned it to you", tone: "plain" },
    snoozed: false,
    outcome: "Taken on",
  },
  {
    id: COMMENT_SIGNAL_ID,
    kind: "tidewatch/commented",
    title: "Mei commented",
    asker: "Mei",
    priority: "normal",
    status: "open",
    createdAt: hoursAgo(5),
    say: { say: "Mei commented", tone: "plain" },
    snoozed: false,
  },
];

const CARDS: readonly InboxCard[] = [
  // Ongoing: Storefront web.
  issue(412, "Basket total rounds the wrong way on multi-buy offers", {
    person: { name: "Tessa" },
    yours: false,
    facts: [{ form: "bars", level: 3 }],
    reason: { say: "Tessa commented", tone: "plain" },
    actingConnections: [ACCOUNT_GITHUB, ACCOUNT_GITHUB_BOT],
    signals: {
      openCount: 2,
      kinds: ["github/commented"],
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
  // Ongoing: the Checkout revamp project, in two milestones and none.
  ticket(142, "Show the delivery cost before the payment step", BETA, {
    person: { name: "Mei" },
    yours: false,
    status: { shape: "half", tone: "active", label: "In progress" },
    reason: { say: "Mei commented", tone: "plain" },
    signals: { openCount: 1, kinds: [TICKET_142_SIGNALS[1]!.kind], latest: TICKET_142_SIGNALS[1]! },
  }),
  ticket(150, "Remember the last address a shopper used", BETA),
  ticket(163, "Retry a failed card payment once", LAUNCH, {
    status: { shape: "most", tone: "active", label: "In review" },
  }),
  ticket(171, "Audit the wording of the checkout errors", undefined),
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
  review(6244, "Show the delivery cost on the payment step", 3, {
    person: { name: "Mei" },
    reason: { say: "Mei asked for your review", tone: "plain" },
    ridesOn: TICKET_142,
  }),
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

/** The `part of` edges between places: each delivery round is part of its site, and each milestone of its project. */
const PLACE_EDGES: readonly EntityEdge[] = [
  { fromRef: WINTER, toRef: SITE },
  { fromRef: RETURNS, toRef: SITE },
  { fromRef: BETA, toRef: CHECKOUT },
  { fromRef: LAUNCH, toRef: CHECKOUT },
];

/**
 * The `part of` edges of the specimen: the edges between places, and from each
 * card to the places nearest to it, which are all of its ancestors except those
 * that another of its ancestors already reaches (a round reaches its site, a
 * milestone its project).
 */
const EDGES: readonly EntityEdge[] = [
  ...PLACE_EDGES,
  ...CARDS.flatMap((card) =>
    card.ancestors
      .filter(
        (ref) =>
          !card.ancestors.some((above) =>
            PLACE_EDGES.some((edge) => edge.fromRef === above && edge.toRef === ref),
          ),
      )
      .map((toRef) => ({ fromRef: card.ref, toRef })),
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

/** The links between the specimen's things: a source's and a person's. */
const LINKS: readonly EntityLink[] = [
  {
    fromRef: ISSUE_412,
    toRef: pullRequestRef(6238),
    hasPersonClaim: false,
    claim: { type: "source", plugin: "github" },
  },
  {
    fromRef: ISSUE_412,
    toRef: pullRequestRef(6101),
    hasPersonClaim: true,
    claim: { type: "person", actor: "user" },
  },
  {
    fromRef: ISSUE_412,
    toRef: "sentry:issue:4471",
    hasPersonClaim: false,
    claim: { type: "source", plugin: "github" },
  },
  {
    fromRef: pullRequestRef(6207),
    toRef: pullRequestRef(6100),
    hasPersonClaim: false,
    claim: { type: "source", plugin: "github" },
  },
  // Tidewatch reports the pull request, so it rides on the ticket.
  {
    fromRef: TICKET_142,
    toRef: pullRequestRef(6244),
    hasPersonClaim: false,
    claim: { type: "source", plugin: "tidewatch" },
  },
];

/** The references found in text between the specimen's things: a pull request that only names a ticket in its description. */
const HINTS: readonly EntityHint[] = [
  { fromRef: pullRequestRef(6219), toRef: ISSUE_398, evidenceKey: "description" },
  { fromRef: pullRequestRef(6203), toRef: TICKET_150, evidenceKey: "description" },
];

/** What `externalEntity.queryInbox` answers in the specimen. */
export const INBOX: Inbox = {
  ...buildInbox(CARDS, {
    places: PLACES,
    edges: EDGES,
    links: LINKS,
    hints: HINTS,
    peers: PEERS,
    offerSets: OFFER_SETS,
  }),
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
    ...TIDEWATCH_PLUGIN,
    entityKinds: [
      kind("tidewatch/ticket", "Ticket", {
        identifier: "SHOP-{number}",
        connect: "Tickets assigned to you",
      }),
      kind("tidewatch/project", "Project", { pace: "context" }),
      kind("tidewatch/milestone", "Milestone", { pace: "context" }),
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

/**
 * The sidebar's lists with the two plugins and their Connections added, for a
 * specimen that opens the Inbox. A run failed on one of the Tasks that hold
 * the "with someone else" cards, so the Overview row shows the failed-run dot.
 */
export const INBOX_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  hasFailedRun: true,
  plugins: PLUGINS,
  connections: [
    connect(CONNECTION_GITHUB, "github/github", "acme"),
    connect(CONNECTION_GITHUB_BOT, "github/github", "northwind-bot"),
    connect("c-quayside", "quayside/quayside", "rotterdam"),
    connect(CONNECTION_TIDEWATCH, "tidewatch/tidewatch", "shop"),
  ],
};

/** The things the first Tidewatch ticket's open card changed at the source, oldest first. */
const TICKET_142_CHANGES: readonly EntityChange[] = [
  { reason: "reassigned", sentence: { say: "Now with Mei", tone: "plain" }, at: daysAgo(3) },
  { reason: "moved", sentence: { say: "Moved to In progress", tone: "plain" }, at: hoursAgo(30) },
];

/** What the open card of the first Tidewatch ticket reads: its detail, and the signal of its open line. */
export const INBOX_OPEN_CARD: InboxOpenCardRecords = (() => {
  const card = CARDS.find((each) => each.id === TICKET_142_ID)!;
  const detail: ExternalEntityDetail = {
    ...card,
    kindAvailable: true,
    fields: [],
    face: null,
    // The places above the ticket, and the target of its link: a link's far end is a place of the detail, drawn with its title and status.
    places: [
      ...PLACES.filter((place) => [BETA, CHECKOUT].includes(place.ref)),
      {
        ref: pullRequestRef(6244),
        kind: "github/pull-request",
        noun: "Pull request",
        identifier: "#6244",
        title: "Show the delivery cost on the payment step",
        status: { shape: "fork", tone: "active", label: "Open", norm: true },
        restricted: false,
      },
    ],
    edges: EDGES.filter((edge) => edge.fromRef === card.ref || edge.fromRef === BETA),
    links: LINKS.filter((link) => link.fromRef === card.ref),
    hints: HINTS.filter((hint) => hint.fromRef === card.ref),
    conflicts: [],
    signals: TICKET_142_SIGNALS,
    openCount: 1,
    signalCount: 2,
    timeline: TICKET_142_CHANGES,
    peers: [],
    offers: OFFER_SETS[card.offerSetId]!,
  };
  const signal: Signal = {
    id: COMMENT_SIGNAL_ID,
    kind: "tidewatch/commented",
    origin: {
      type: "event",
      eventId: 9001,
      connectionId: "01a0d1c0-6e80-7000-8000-0000000000c3",
      threadRef: card.ref,
    },
    title: "Mei commented",
    asker: "Mei",
    place: "Checkout revamp",
    priority: "normal",
    blocks: [],
    actions: [
      {
        id: "reply",
        label: "Reply",
        operation: null,
        primary: true,
        field: { name: "body", placeholder: "Write a reply" },
        describeLine: [{ kind: "text", text: "Replies on SHOP-142 in Tidewatch" }],
      },
      {
        id: "done",
        label: "Mark done",
        operation: null,
        describeLine: [{ kind: "text", text: "Takes it off your list. Tidewatch is not told" }],
      },
    ],
    match: {},
    status: "open",
    createdAt: TICKET_142_SIGNALS[1]!.createdAt,
  };
  return { detail, signals: [signal] };
})();

/** The id of the card the open card specimen opens. */
export const INBOX_OPEN_CARD_ID = TICKET_142_ID;
