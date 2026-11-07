/**
 * Tests the Inbox screen through the rendered app: its read (once on opening,
 * again on an `externalEntity` push, none while the window is hidden), the
 * surfaces and the cards, what a stale card says, the side a card keeps for
 * the visit, the empty Inbox (first run and all clear), Group by and Filter
 * with the sidebar's number, and the lines about a failing source, a cut-short
 * Inbox and a controller that cannot be reached.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, EntityPlace, Inbox, InboxCard, PluginDetail } from "@hercule/contract";
import {
  buildInbox,
  buildInboxCard,
  buildInboxPlace,
  buildRequestCard,
  buildSourceConnection,
  buildSourcePlugin,
} from "@hercule/client-core/inbox/testing";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns a valid id for the card numbered `n`. */
const buildCardId = (n: number): string => `01a1b576-c999-7000-8000-${String(n).padStart(12, "0")}`;

const PRICING = buildInboxPlace("acme:project:pricing", "Pricing rules");
const CHECKOUT = buildInboxPlace("acme:project:checkout", "Checkout");
const SHOP_WEB: EntityPlace = {
  ref: "acme:repository:shop-web",
  kind: "acme/repository",
  noun: "Repository",
  caption: "Acme repository",
  title: "shop-web",
  restricted: false,
};

const ticket = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildInboxCard(String(n), {
    id: buildCardId(n),
    title,
    status: { shape: "ring", tone: "quiet", label: "Open" },
    ancestors: [PRICING.ref],
    ...overrides,
  });

const review = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildRequestCard(String(n), {
    id: buildCardId(n),
    title,
    ancestors: [SHOP_WEB.ref],
    person: { name: "Ines" },
    reason: { say: "Ines asked for your review", tone: "plain" },
    ...overrides,
  });

const ROUNDING = ticket(1, "Fix the basket rounding", { yours: true });
const RETRIES = ticket(2, "Retry card payments once", {
  ancestors: [CHECKOUT.ref],
  status: { shape: "half", tone: "active", label: "In progress" },
  person: { name: "Tessa" },
});
const SLOTS = review(3, "Cache delivery slot lookups");
const LOYALTY = review(4, "Round loyalty points down", { yours: true });

const CARDS: readonly InboxCard[] = [ROUNDING, RETRIES, SLOTS, LOYALTY];

const COUNTS = { onTheClock: 22, requests: 2, withSomeoneElse: 0, newestArrival: 5 };

const buildPageInbox = (cards: readonly InboxCard[], overrides: Partial<Inbox> = {}): Inbox => ({
  ...buildInbox(cards, { places: [PRICING, CHECKOUT, SHOP_WEB] }),
  counts: COUNTS,
  ...overrides,
});

const INBOX_PATH = "GET /api/v1/external-entities/inbox";

/** Counts the Inbox reads in `calls`. */
const countInboxReads = (calls: readonly Call[]): number =>
  calls.filter((call) => `${call.method} ${call.path}` === INBOX_PATH).length;

const ACME = buildSourcePlugin("acme", "Acme", [
  { word: "acme/ticket", connect: "Tickets, with their projects" },
  { word: "acme/review", card: "compact", pace: "fast", connect: "Reviews people ask of you" },
]);

/**
 * Opens the Inbox. `inbox` is what the controller answers to each read.
 * `plugins` and `connections` are what the shell holds.
 */
const openInbox = async ({
  inbox = () => buildPageInbox(CARDS),
  plugins = [ACME],
  connections = [buildSourceConnection(buildCardId(800), "acme/account")],
  handlers = {},
  retryFailedReads = true,
}: {
  readonly inbox?: () => Inbox;
  readonly plugins?: readonly PluginDetail[];
  readonly connections?: readonly Connection[];
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly retryFailedReads?: boolean;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [INBOX_PATH]: () => ({ body: inbox() }),
    "GET /api/v1/external-entities/inbox/count": () => ({ body: inbox().counts }),
    "GET /api/v1/plugins": { body: plugins },
    "GET /api/v1/connections": { body: { items: connections } },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/inbox", retryFailedReads },
  );
  return { calls, ...app };
};

/** Returns the card whose screen-reader words start with `words`. */
const getCard = (words: RegExp): HTMLElement => screen.getByRole("listitem", { name: words });

/** Returns the surface of the place named `name`. */
const getSurface = (name: string): HTMLElement =>
  screen.getByRole("heading", { name }).closest("section")!;

/** Returns the sidebar's Inbox row, whose name carries its number. */
const getSidebarInboxRow = (): HTMLElement => screen.getByRole("link", { name: /^Inbox, / });

describe("the Inbox screen", () => {
  it("reads the Inbox once, and draws lasting work on the surface of its place and requests as small cards", async () => {
    const { calls } = await openInbox();

    await screen.findByText("Fix the basket rounding");
    expect(countInboxReads(calls)).toBe(1);
    expect(
      within(getSurface("Pricing rules")).getByRole("listitem", {
        name: /Fix the basket rounding/,
      }),
    ).toBeTruthy();
    expect(
      within(getSurface("Checkout")).getByRole("listitem", { name: /Retry card payments once/ }),
    ).toBeTruthy();
    const requests = screen.getByRole("complementary", { name: "Requests" });
    expect(
      within(requests).getByRole("listitem", { name: /Cache delivery slot lookups/ }),
    ).toBeTruthy();
    // The usual reason of a request needs only a name, and its place, and `yours` beside it.
    expect(getCard(/Cache delivery slot lookups/).textContent).toContain("Ines");
    expect(getCard(/Round loyalty points down/).textContent).toContain("shop-web");
    expect(getCard(/Round loyalty points down/).textContent).toContain("yours");
  });

  it("reads again when the controller pushes a change to an entity", async () => {
    let title = "Cache delivery slot lookups";
    const { calls, live } = await openInbox({
      inbox: () => buildPageInbox([ROUNDING, review(3, title)]),
    });
    await screen.findByText("Cache delivery slot lookups");
    await live.waitForFirstPushes();
    const before = countInboxReads(calls);

    title = "Cache delivery slots for a minute";
    live.pushInvalidation("externalEntity");

    await screen.findByText("Cache delivery slots for a minute");
    expect(countInboxReads(calls)).toBe(before + 1);
  });

  it("reads nothing while the window is hidden, and reads once when it shows", async () => {
    setVisibility("hidden");
    const { calls } = await openInbox();
    await screen.findByText("Loading the Inbox");
    // Give a read that should not happen the time to start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countInboxReads(calls)).toBe(0);

    setVisibility("visible");

    await screen.findByText("Fix the basket rounding");
    expect(countInboxReads(calls)).toBe(1);
  });

  it("says why a card may be out of date instead of hiding it", async () => {
    const lastRead = new Date(Date.now() - 3.5 * DAY_MS).toISOString();
    await openInbox({
      inbox: () =>
        buildPageInbox([
          ticket(1, "Fix the basket rounding", { stale: true, observedAt: lastRead }),
        ]),
    });

    const card = await screen.findByRole("listitem", { name: /Fix the basket rounding/ });
    expect(card.textContent).toContain("Last read 3 days ago");
  });

  it("keeps a card on the side it was first seen on, and settles it under With someone else on the next visit", async () => {
    let inbox = buildPageInbox([ROUNDING, SLOTS]);
    const { live } = await openInbox({ inbox: () => inbox });
    await screen.findByRole("listitem", { name: /Cache delivery slot lookups/ });
    await live.waitForFirstPushes();

    // Someone takes the request on: the controller now puts it under With someone else.
    inbox = buildPageInbox([
      ROUNDING,
      { ...SLOTS, side: "with-someone-else", taskId: buildCardId(900) },
    ]);
    live.pushInvalidation("externalEntity");

    await waitFor(() => {
      // Its wait ended, but it is still in the column, where the user had it.
      expect(getCard(/Cache delivery slot lookups/).textContent).not.toMatch(/\d+[hd]$/);
    });
    const requests = screen.getByRole("complementary", { name: "Requests" });
    expect(within(requests).queryByRole("button", { name: /With someone else/ })).toBeNull();

    cleanup();
    await openInbox({ inbox: () => inbox });

    const toggle = await screen.findByRole("button", { name: /With someone else/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeNull();
    await userEvent.setup().click(toggle);
    expect(screen.getByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeTruthy();
  });

  it("rearranges by Group by and Filter without a read, and without changing the sidebar's number", async () => {
    const user = userEvent.setup();
    const { calls, live } = await openInbox();
    await screen.findByText("Fix the basket rounding");
    await live.waitForFirstPushes();
    await waitFor(() => {
      expect(getSidebarInboxRow().getAttribute("aria-label")).toBe("Inbox, 22 waiting");
    });
    const reads = countInboxReads(calls);

    await user.click(screen.getByRole("menuitemradio", { name: "Status", hidden: true }));

    // The surfaces are named for the statuses now, and no longer for the places.
    expect(screen.queryByRole("heading", { name: "Pricing rules" })).toBeNull();
    expect(
      within(getSurface("In progress")).getByRole("listitem", { name: /Retry card payments once/ }),
    ).toBeTruthy();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Mine/, hidden: true }));

    expect(screen.getByRole("button", { name: "Remove filter Mine" })).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: /Retry card payments once/ })).toBeNull();
    expect(screen.queryByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeNull();
    expect(screen.getByRole("listitem", { name: /Round loyalty points down/ })).toBeTruthy();
    expect(getSidebarInboxRow().getAttribute("aria-label")).toBe("Inbox, 22 waiting");
    expect(countInboxReads(calls)).toBe(reads);
  });

  it("keeps the grouping the user chose when the Inbox is opened again", async () => {
    const user = userEvent.setup();
    await openInbox();
    await screen.findByText("Fix the basket rounding");
    await user.click(screen.getByRole("menuitemradio", { name: "Status", hidden: true }));

    cleanup();
    await openInbox();

    await screen.findByText("Fix the basket rounding");
    expect(screen.queryByRole("heading", { name: "Pricing rules" })).toBeNull();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeTruthy();
  });

  it("asks for sources on a first run, and says all clear once a source is connected", async () => {
    await openInbox({ inbox: () => buildPageInbox([]), connections: [] });
    expect(await screen.findByText("This is where the outside world reaches you.")).toBeTruthy();
    expect(screen.getByText("Tickets, with their projects")).toBeTruthy();
    expect(screen.getByText("Reviews people ask of you")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /^Acme/ })).toHaveLength(2);

    cleanup();
    await openInbox({ inbox: () => buildPageInbox([]) });
    expect(await screen.findByText("All clear.")).toBeTruthy();
    expect(screen.queryByText("This is where the outside world reaches you.")).toBeNull();
  });

  it("says no requests are left under a small sunrise while lasting work stays", async () => {
    await openInbox({ inbox: () => buildPageInbox([ROUNDING]) });

    expect(await screen.findByText("No requests left.")).toBeTruthy();
    expect(screen.getByText("Fix the basket rounding")).toBeTruthy();
  });

  it("names a source that fails and what it means for its cards, with a way to its Connection", async () => {
    await openInbox({
      connections: [
        buildSourceConnection(buildCardId(800), "acme/account", { status: "needs-reauth" }),
      ],
    });

    expect(
      await screen.findByText("Acme needs you to sign in again. Its cards may be out of date."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connections" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
  });

  it("says when the Inbox shows only some of its cards", async () => {
    await openInbox({ inbox: () => buildPageInbox([ROUNDING], { truncated: true }) });

    expect(
      await screen.findByText(/The Inbox shows the first 1,000 cards, and more exist/),
    ).toBeTruthy();
  });

  it("says since when the controller cannot be reached, and that a move fails until then", async () => {
    const { live } = await openInbox();
    await screen.findByText("Fix the basket rounding");
    await live.waitForFirstPushes();

    live.drop();

    expect(
      await screen.findByText(
        /^Offline\. What you see is from .*A move fails until you are back\.$/,
      ),
    ).toBeTruthy();
  });

  it("shows why the Inbox could not be read, with a way to try again", async () => {
    let answers = 0;
    const user = userEvent.setup();
    await openInbox({
      retryFailedReads: false,
      handlers: {
        [INBOX_PATH]: () => {
          answers += 1;
          // The loader reads once, and the screen reads again as it opens.
          if (answers <= 2) throw new Error("connection refused");
          return { body: buildPageInbox(CARDS) };
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Fix the basket rounding")).toBeTruthy();
  });
});
