/**
 * The records of the Wiki specimen (wiki.tsx): the six pages of the Bureau
 * book's Wiki page (docs/design/crew-bureau-2/desktop/wiki.html), and the
 * open one, "Checkout architecture", with its body and its seven revisions,
 * as the controller would return them at the clock of list-week-clock.ts,
 * Wednesday 14 October 2026, 09:41 UTC.
 *
 * The list is in the order the controller returns it, last changed first. The
 * app groups it by project and repository, which gives the book's order.
 *
 * The page's History is the book's seven revisions, newest first. The page
 * was called "Checkout flow" until revision 5 renamed it, so the older
 * revision the book opens (4) reads under the old title.
 */
import type {
  Session,
  WikiPage,
  WikiPageSummary,
  WikiPageWithRevisions,
  WikiRevision,
} from "@hercule/contract";
import {
  AGENT_SESSIONS,
  buildInstant,
  buildId,
  CHECKOUT_API,
  GIFT_CARD_AGENT,
  LEGACY_ADMIN,
  PAYMENTS,
  PAYOUT_AGENT,
  REFACTOR_AGENT,
  ROUNDING_AGENT,
  STOREFRONT,
  buildSessionStamp,
} from "./discussions-wiki-world";

/** What the Wiki screen reads, each under the key its query holds it by. */
export interface WikiRecords {
  /** The first page of the listing, last changed first. */
  readonly pages: ReadonlyArray<WikiPageSummary>;
  /** The open page as of its current revision, with its history. */
  readonly openPage: WikiPageWithRevisions;
  /** The open page as of its revision 4, which the book opens as the older revision. */
  readonly olderRevision: WikiPageWithRevisions;
  /** The older revision's number. */
  readonly olderRevisionNumber: number;
  /** The sessions of the agents that wrote, which name each agent and give it its face. */
  readonly senders: ReadonlyArray<Session>;
}

/** The run that wrote revision 4 of the open page and the page "Feature flags". The last eight characters of its id are the "4f2a91c0" the book shows. */
const RUN_ACTOR = "run:01a06d02-7c10-7000-8000-00004f2a91c0";
const USER_ACTOR = "user";

/** One page of the book's list, as the fixture writes it. */
interface FixturePage {
  readonly repository: { readonly resourceId: string; readonly repository: string };
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly revision: number;
  readonly updatedBy: string;
  /** The current revision's moment, an ISO instant. */
  readonly updatedAt: string;
}

/**
 * The book's six pages, last changed first. The list shows a page's time as
 * "09:41" today, a weekday within six days, then a date.
 */
const BOOK_PAGES: ReadonlyArray<FixturePage> = [
  {
    repository: STOREFRONT,
    slug: "checkout-architecture",
    title: "Checkout architecture",
    summary:
      "How a cart becomes an order: totals, tax, payment intents and the confirmation email.",
    revision: 7,
    updatedBy: buildSessionStamp(REFACTOR_AGENT),
    updatedAt: buildInstant("2026-10-14", "09:41"),
  },
  {
    repository: PAYMENTS,
    slug: "payout-retries",
    title: "Payout retries",
    summary:
      "The backoff schedule, the idempotency key, and what support sees when a payout fails.",
    revision: 3,
    updatedBy: buildSessionStamp(PAYOUT_AGENT),
    updatedAt: buildInstant("2026-10-14", "07:55"),
  },
  {
    repository: CHECKOUT_API,
    slug: "prisma-migrations",
    title: "Prisma migrations",
    summary: "Write, review and roll back a migration without locking the orders table.",
    revision: 2,
    updatedBy: buildSessionStamp(GIFT_CARD_AGENT),
    updatedAt: buildInstant("2026-10-13", "15:20"),
  },
  {
    repository: STOREFRONT,
    slug: "running-the-e2e-suite",
    title: "Running the e2e suite",
    summary: "Playwright against a seeded database: the flags to use and how to read a failure.",
    revision: 4,
    updatedBy: USER_ACTOR,
    updatedAt: buildInstant("2026-10-12", "10:15"),
  },
  {
    repository: STOREFRONT,
    slug: "feature-flags",
    title: "Feature flags",
    summary: "Where flags live, how they are named, and when to remove one.",
    revision: 2,
    updatedBy: RUN_ACTOR,
    updatedAt: buildInstant("2026-10-03", "11:30"),
  },
  {
    repository: LEGACY_ADMIN,
    slug: "what-is-left-in-legacy-admin",
    title: "What is left in legacy admin",
    summary: "The three screens still in use, and who uses them.",
    revision: 1,
    updatedBy: USER_ACTOR,
    updatedAt: buildInstant("2026-09-12", "10:02"),
  },
];

const PAGES: ReadonlyArray<WikiPageSummary> = BOOK_PAGES.map(
  ({ repository, slug, title, summary, revision, updatedBy, updatedAt }, index) => ({
    id: buildId("7f00", index + 1),
    resourceId: repository.resourceId,
    repository: repository.repository,
    slug,
    title,
    summary,
    revision,
    updatedAt,
    updatedBy,
    createdAt: buildInstant("2026-09-28", "09:00"),
  }),
);

/** The first page: the one the book opens. */
const OPEN_SUMMARY = PAGES[0]!;

/** The body of "Checkout architecture", the same in every revision the book shows. */
const OPEN_BODY = [
  "## The order of things",
  "",
  "A cart turns into an order in four steps, each in its own module under `src/cart/`. Each step reads only what the one before it wrote.",
  "",
  "1. **Totals** - `computeTotals` rounds each line with `roundHalfEven`, then sums.",
  "2. **Tax** - `applyTax` asks the tax service per shipping address. It never rounds again.",
  "3. **Payment** - `createIntent` opens a Stripe payment intent for the total, in minor units.",
  "4. **Confirmation** - the `order.paid` webhook sends the email. Nothing else does.",
  "",
  "## Things that bit us",
  "",
  "- Rounding the sum instead of each line is off by a cent on carts of three or more lines.",
  "- Gift cards pay before tax, so `applyTax` takes the total net of gift cards.",
  "- Test cards in `e2e/fixtures/cards.ts` only work against the Stripe test key.",
  "",
  "## Where to change what",
  "",
  "Change the rounding rule in `src/cart/totals/round.ts` and nowhere else; the tests in `totals.test.ts` hold a case per rounding mode.",
  "",
  "```ts",
  "export const roundLine = (item: CartItem) => roundHalfEven(item.price * item.quantity);",
  "```",
].join("\n");

/** The title the page had before revision 5 renamed it. */
const OLD_TITLE = "Checkout flow";

/** One revision of the open page's history, as the fixture writes it. */
interface FixtureRevision {
  readonly revision: number;
  readonly actor: string;
  readonly at: string;
}

/** The book's seven revisions, newest first. */
const BOOK_REVISIONS: ReadonlyArray<FixtureRevision> = [
  {
    revision: 7,
    actor: buildSessionStamp(REFACTOR_AGENT),
    at: buildInstant("2026-10-14", "09:41"),
  },
  {
    revision: 6,
    actor: buildSessionStamp(ROUNDING_AGENT),
    at: buildInstant("2026-10-13", "14:05"),
  },
  { revision: 5, actor: USER_ACTOR, at: buildInstant("2026-10-12", "10:30") },
  { revision: 4, actor: RUN_ACTOR, at: buildInstant("2026-10-02", "13:10") },
  {
    revision: 3,
    actor: buildSessionStamp(GIFT_CARD_AGENT),
    at: buildInstant("2026-10-01", "16:45"),
  },
  { revision: 2, actor: USER_ACTOR, at: buildInstant("2026-09-28", "15:00") },
  {
    revision: 1,
    actor: buildSessionStamp(REFACTOR_AGENT),
    at: buildInstant("2026-09-28", "09:30"),
  },
];

const REVISIONS: ReadonlyArray<WikiRevision> = BOOK_REVISIONS.map(
  ({ revision, actor, at: moment }): WikiRevision => ({
    revision,
    title: revision >= 5 ? OPEN_SUMMARY.title : OLD_TITLE,
    summary: OPEN_SUMMARY.summary,
    at: moment,
    actor,
  }),
);

/** The older revision the book opens: revision 4, under the old title. */
const OLDER_REVISION_NUMBER = 4;
const OLDER_REVISION = REVISIONS.find((each) => each.revision === OLDER_REVISION_NUMBER)!;

const OPEN_PAGE: WikiPage = { ...OPEN_SUMMARY, body: OPEN_BODY };

export const WIKI_RECORDS: WikiRecords = {
  pages: PAGES,
  openPage: { page: OPEN_PAGE, revisions: REVISIONS },
  olderRevision: {
    page: {
      ...OPEN_PAGE,
      title: OLDER_REVISION.title,
      revision: OLDER_REVISION.revision,
      updatedAt: OLDER_REVISION.at,
      updatedBy: OLDER_REVISION.actor,
    },
    revisions: REVISIONS,
  },
  olderRevisionNumber: OLDER_REVISION_NUMBER,
  senders: AGENT_SESSIONS,
};
