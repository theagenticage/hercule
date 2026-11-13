/**
 * What the Inbox specimen's pane reads besides the row (inbox-fixture.ts): the
 * signal of each ask with its answers, what each source shows of its thing
 * (`externalEntity.readBlocks`), and the links, facts and history of the
 * things the pane is drawn for.
 *
 * The content of pull request #6244 is the content of the same pull request in
 * the Inbox drawing (docs/design/inbox-list, js/world.js): Omar's mention and
 * Mei's review request, the change, the failing check and the description.
 */
import type {
  EntityBlocks,
  EntityPeer,
  ExternalEntityDetail,
  InboxAsk,
  InboxThing,
  Signal,
  SignalAction,
} from "@hercule/contract";
import { SPECIMEN_NOW } from "./sidebar-fixture";

const HOUR_MS = 3_600_000;

/** Returns the moment `hours` hours before the specimen's clock, as an ISO timestamp. */
export const hoursAgo = (hours: number): string =>
  new Date(SPECIMEN_NOW - hours * HOUR_MS).toISOString();

/** Builds the id of the specimen's record number `n`. */
export const buildId = (n: number): string =>
  `01a2f000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const REVIEW = "github/review-requested";
export const MENTION = "github/mentioned";
export const REGRESSED = "sentry/regressed";

const GITHUB_CONNECTION_ID = buildId(900);
const SENTRY_CONNECTION_ID = buildId(902);

/** Splits `line` at each `**`: every second part is a marked name. */
const buildDescribeLine = (line: string): NonNullable<SignalAction["describeLine"]> =>
  line
    .split("**")
    .map((text, index) => ({
      kind: index % 2 === 1 ? ("marked" as const) : ("text" as const),
      text,
    }))
    .filter((part) => part.text !== "");

/** Builds an answer that runs the plugin operation `op` through `connectionId`. */
const buildAnswer = (
  connectionId: string,
  id: string,
  label: string,
  op: string,
  line: string,
  extra: Partial<SignalAction> = {},
): SignalAction => ({
  id,
  label,
  operation: { op, connectionId, input: {} },
  describeLine: buildDescribeLine(line),
  ...extra,
});

const DONE: SignalAction = { id: "done", label: "Done", operation: null };

/** Returns the answers of a signal of `kind` on `thing`: what its plugin offers, then Done. */
const buildAnswers = (
  thing: InboxThing,
  kind: string,
  asker: string,
): ReadonlyArray<SignalAction> => {
  const reference = thing.identifier ?? thing.title;
  switch (kind) {
    case REVIEW:
      return [
        buildAnswer(
          GITHUB_CONNECTION_ID,
          "approve",
          "Approve",
          "github/pr.review",
          `Approves **${reference}** as you on **GitHub**.`,
          { primary: true },
        ),
        buildAnswer(
          GITHUB_CONNECTION_ID,
          "request-changes",
          "Request changes…",
          "github/pr.review",
          `Asks **${asker}** for changes, with your note.`,
          { field: { name: "body", placeholder: `Request changes on ${reference}…` } },
        ),
        buildAnswer(
          GITHUB_CONNECTION_ID,
          "comment",
          "Comment…",
          "github/pr.review",
          `Posts your comment on **${reference}**.`,
          { field: { name: "body", placeholder: `Comment on ${reference}…` } },
        ),
        DONE,
      ];
    case MENTION:
      return [
        buildAnswer(
          GITHUB_CONNECTION_ID,
          "reply",
          "Reply…",
          "github/pr.comment",
          `Replies to **${asker}** on **${reference}**.`,
          { primary: true, field: { name: "body", placeholder: `Reply to ${asker}…` } },
        ),
        DONE,
      ];
    default:
      return [
        buildAnswer(
          SENTRY_CONNECTION_ID,
          "resolve",
          "Resolve",
          "sentry/issue.resolve",
          "Marks it resolved in **Sentry**.",
        ),
        buildAnswer(
          SENTRY_CONNECTION_ID,
          "ignore",
          "Ignore for a day",
          "sentry/issue.ignore",
          "Mutes it in **Sentry** for 24 hours.",
        ),
        DONE,
      ];
  }
};

/** The one message of the mentions that have a thread to read, by the identifier of their thing. */
const MENTION_MESSAGES: Readonly<
  Record<string, { readonly author: string; readonly hours: number; readonly text: string }>
> = {
  "#6244": {
    author: "Omar Haddad",
    hours: 2,
    text: "@you the delivery cost now rounds before VAT on the payment step. Is that what Finance asked for? See `delivery-cost.ts` line 88.",
  },
  "#6230": {
    author: "Kwame Mensah",
    hours: 0.4,
    text: "@you the courier app still calls /wishlist/sync on start. Can we keep it one more release?",
  },
};

/** Builds the blocks of the signal of `ask` on `thing`: the mention's message when the fixture has one. */
const buildAskBlocks = (thing: InboxThing, ask: InboxAsk): Signal["blocks"] => {
  const message = ask.kind === MENTION ? MENTION_MESSAGES[thing.identifier ?? ""] : undefined;
  return message === undefined
    ? []
    : [
        {
          type: "messages",
          omitted: 0,
          messages: [
            {
              author: { name: message.author },
              at: hoursAgo(message.hours),
              text: message.text,
              mentionsYou: true,
            },
          ],
        },
      ];
};

/** Builds the signal `signal.read` returns for `ask` of `thing`, with the answers its kind offers. */
export const buildAskSignal = (thing: InboxThing, ask: InboxAsk): Signal => ({
  id: ask.id,
  kind: ask.kind,
  origin: {
    type: "event",
    eventId: 1,
    connectionId: ask.kind === REGRESSED ? SENTRY_CONNECTION_ID : GITHUB_CONNECTION_ID,
    threadRef: thing.ref,
  },
  title: ask.say.say,
  ...(ask.asker === undefined ? {} : { asker: ask.asker }),
  priority: "normal",
  blocks: buildAskBlocks(thing, ask),
  actions: buildAnswers(thing, ask.kind, ask.asker ?? "Sentry"),
  match: {},
  status: "open",
  createdAt: ask.createdAt,
});

const trendPoints = (
  values: ReadonlyArray<number>,
): NonNullable<EntityBlocks["blocks"]>[number] => ({
  type: "trend",
  caption: "Events, last 14 days",
  points: values.map((value, index) => ({
    at: hoursAgo((values.length - 1 - index) * 24),
    value,
  })),
});

/** What each source shows of its thing, by the thing's number: the blocks of `externalEntity.readBlocks`. */
export const PANE_BLOCKS: ReadonlyMap<number, EntityBlocks> = new Map<number, EntityBlocks>([
  [
    1,
    {
      blocks: [
        {
          type: "change",
          from: "mei/delivery-cost-step",
          to: "main",
          files: 6,
          additions: 142,
          deletions: 38,
          checks: { passed: 11, failed: 1, pending: 0 },
        },
        {
          type: "checks",
          rows: [
            {
              name: "e2e / checkout-eu",
              state: "failed",
              log: '✕ shows the delivery cost before payment (4.2s)\n  Expected: "€4.95"\n  Received: "€4.90"',
            },
          ],
          passed: 11,
          omitted: 0,
        },
        {
          type: "text",
          title: "Description",
          markdown:
            "Adds the delivery cost to the payment step's summary, rounded the way the invoice rounds it. Closes SHOP-142.",
        },
      ],
    },
  ],
  [
    2,
    {
      blocks: [
        {
          type: "change",
          from: "tessa/shared-order-schema",
          to: "main",
          files: 23,
          additions: 412,
          deletions: 389,
          checks: { passed: 14, failed: 0, pending: 0 },
        },
        {
          type: "text",
          title: "Description",
          markdown:
            "Moves `OrderSchema` and its codecs to `@northwind/shared` so the mobile app can import them. No behaviour change.",
        },
      ],
    },
  ],
  [
    6,
    {
      blocks: [
        trendPoints([2, 2, 3, 2, 4, 3, 5, 9, 14, 22, 31, 48, 70, 96, 128]),
        {
          type: "fields",
          rows: [
            { label: "Level", value: "error" },
            { label: "First seen", value: "6 days ago, in 2026.11.06-1" },
            { label: "Last seen", value: "4 minutes ago" },
            { label: "Users", value: "312" },
            { label: "Browser", value: "Safari 19 · 61%" },
          ],
        },
        {
          type: "code",
          title: "Stack trace",
          text: "at computeSummary (checkout/summary.ts:41:23)\nat PaymentStep.render (checkout/payment-step.tsx:88:12)\nat renderWithHooks (react-dom.production.js:1:2210)",
        },
      ],
    },
  ],
  [
    7,
    {
      blocks: [
        {
          type: "fields",
          rows: [
            { label: "Status", value: "In Progress" },
            { label: "Priority", value: "High" },
            { label: "Project", value: "Checkout revamp" },
            { label: "Cycle", value: "Cycle 47 · ends Friday" },
            { label: "Estimate", value: "3 points" },
          ],
        },
        {
          type: "text",
          title: "Description",
          markdown:
            "Shoppers only see the delivery cost once they reach the payment step, and 14% of them leave there. Show it on the basket and on the delivery step, with the same rounding Finance uses on the invoice.",
        },
      ],
    },
  ],
]);

const SHOP_142_REF = "tidewatch:ticket:shop-142";
const SENTRY_ISSUE_REF = "sentry:issue:storefront-1z9";

const SHOP_142_PEER: EntityPeer = {
  id: buildId(7),
  ref: SHOP_142_REF,
  kind: "tidewatch/ticket",
  noun: "Ticket",
  identifier: "SHOP-142",
  title: "Show the delivery cost before the payment step",
  yours: true,
  restricted: false,
};

const SENTRY_ISSUE_PEER: EntityPeer = {
  id: buildId(6),
  ref: SENTRY_ISSUE_REF,
  kind: "sentry/issue",
  noun: "Issue",
  identifier: "STOREFRONT-1Z9",
  title: "TypeError: Cannot read properties of undefined (reading 'deliveryCost')",
  yours: false,
  restricted: false,
};

/** What the read of pull request #6244 holds besides what every thing's read holds. */
const PULL_REQUEST_6244: Partial<ExternalEntityDetail> = {
  facts: [
    { form: "delta", added: 142, removed: 38 },
    { form: "count", value: 6, unit: "file" },
  ],
  links: [
    {
      fromRef: "github:pull-request:acme/storefront-web#6244",
      toRef: SHOP_142_REF,
      claim: { type: "source", plugin: "tidewatch" },
      hasPersonClaim: false,
    },
    {
      fromRef: SENTRY_ISSUE_REF,
      toRef: "github:pull-request:acme/storefront-web#6244",
      claim: { type: "person", actor: "user" },
      hasPersonClaim: true,
    },
  ],
  peers: [SHOP_142_PEER, SENTRY_ISSUE_PEER],
  timeline: [
    {
      reason: "linked",
      sentence: { say: "Mei linked SHOP-142", tone: "plain" },
      at: hoursAgo(72),
      ref: SHOP_142_REF,
    },
    {
      reason: "moved",
      sentence: { say: "Moved to In review", tone: "plain" },
      at: hoursAgo(26),
    },
    {
      reason: "moved",
      sentence: { say: "e2e / checkout-eu failed", tone: "bad" },
      at: hoursAgo(20),
    },
    {
      reason: "reassigned",
      sentence: { say: "Omar joined as a reviewer", tone: "plain" },
      at: hoursAgo(6),
    },
  ],
};

/** What the read of a thing holds besides what every thing's read holds, by the thing's number. */
export const DETAIL_EXTRAS: ReadonlyMap<number, Partial<ExternalEntityDetail>> = new Map<
  number,
  Partial<ExternalEntityDetail>
>([
  [1, PULL_REQUEST_6244],
  [
    2,
    {
      facts: [
        { form: "delta", added: 412, removed: 389 },
        { form: "count", value: 23, unit: "file" },
      ],
      timeline: [
        {
          reason: "reassigned",
          sentence: { say: "Tessa asked for your review", tone: "plain" },
          at: hoursAgo(30),
        },
      ],
    },
  ],
]);
