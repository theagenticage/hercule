/**
 * Tests the Inbox screen through the rendered app: its read (once on opening,
 * again on an `externalEntity` push, none while the window is hidden), the
 * surfaces and the cards, what a stale card says, the side a card keeps for
 * the visit, the empty Inbox (first run and all clear), Group by and Filter
 * with the sidebar's number, and the lines about a failing source, a cut-short
 * Inbox and a controller that cannot be reached.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  holdAnswer,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../app/testing";

// The Work board, which some tests open, stops the paws of a colleague out of view.
beforeEach(() => {
  stubIntersectionObserver();
});

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

// ---------- The moves ----------

const TASK_ID = buildCardId(900);

const takeOnPath = (card: InboxCard): string => `POST /api/v1/external-entities/${card.id}/take-on`;
const undoTakeOnPath = (card: InboxCard): string =>
  `POST /api/v1/external-entities/${card.id}/take-on/undo`;
const dismissPath = (card: InboxCard): string =>
  `POST /api/v1/external-entities/${card.id}/dismiss`;
const restorePath = (card: InboxCard): string =>
  `POST /api/v1/external-entities/${card.id}/restore`;

/** Lists the calls in `calls` to the operation `path`, written `METHOD /path`. */
const listCallsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

/** Returns the Undo button of the undo line. */
const getUndoButton = (): HTMLElement => screen.getByRole("button", { name: /^Undo/ });

/** Returns the button of a card's moves named `name`. */
const getMove = (card: HTMLElement, name: string): HTMLElement =>
  within(card).getByRole("button", { name, hidden: true });

/** Rests the pointer on a card, which shows its moves, and presses the move named `name`. */
const pressMove = async (
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
  name: string,
): Promise<void> => {
  await user.hover(card);
  await user.click(getMove(card, name));
};

describe("the Inbox's moves", () => {
  it("takes a card on: its monogram stands where the wait was, the card keeps its place, and Undo takes the Task back", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      handlers: {
        [takeOnPath(SLOTS)]: { body: { taskId: TASK_ID, created: true } },
        [undoTakeOnPath(SLOTS)]: { body: { undone: true } },
      },
    });
    const requests = await screen.findByRole("complementary", { name: "Requests" });
    expect(getCard(/Cache delivery slot lookups/).textContent).toMatch(/\d+[hd]/);

    await pressMove(user, getCard(/Cache delivery slot lookups/), "Take it");

    expect(await screen.findByText("Took on Review #3. A Task is on Work.")).toBeTruthy();
    const taken = within(requests).getByRole("listitem", { name: /Cache delivery slot lookups/ });
    expect(within(taken).getByTitle("You have it")).toBeTruthy();
    expect(taken.textContent).not.toMatch(/Take it\d*[hd]$/);
    expect(taken.hasAttribute("data-has-task")).toBe(true);
    // Its moves now offer the Task, not a second Take.
    expect(within(taken).queryByRole("button", { name: "Take it", hidden: true })).toBeNull();
    expect(getMove(taken, "On Work")).toBeTruthy();
    expect(listCallsTo(calls, takeOnPath(SLOTS))).toHaveLength(1);

    await user.click(getUndoButton());

    expect(await screen.findByText("Put back: Took on Review #3.")).toBeTruthy();
    expect(listCallsTo(calls, undoTakeOnPath(SLOTS))[0]?.body).toEqual({ taskId: TASK_ID });
    const freed = getCard(/Cache delivery slot lookups/);
    expect(within(freed).queryByTitle("You have it")).toBeNull();
    expect(freed.hasAttribute("data-has-task")).toBe(false);
  });

  it("says a Task that was touched since stays, with the reason, and keeps the monogram", async () => {
    const user = userEvent.setup();
    await openInbox({
      handlers: {
        [takeOnPath(SLOTS)]: { body: { taskId: TASK_ID, created: true } },
        [undoTakeOnPath(SLOTS)]: {
          body: { undone: false, reason: "A Thread was started on it." },
        },
      },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Take it",
    );
    await screen.findByText("Took on Review #3. A Task is on Work.");

    await user.click(getUndoButton());

    expect(
      await screen.findByText("Could not put back: Took on Review #3. A Thread was started on it."),
    ).toBeTruthy();
    expect(within(getCard(/Cache delivery slot lookups/)).getByTitle("You have it")).toBeTruthy();
  });

  it("says a card already had a Task when Take finds one, and offers no Undo", async () => {
    const user = userEvent.setup();
    await openInbox({
      handlers: { [takeOnPath(SLOTS)]: { body: { taskId: TASK_ID, created: false } } },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Take it",
    );

    expect(
      await screen.findByText("Review #3 already had a Task, so no new one was made."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(within(getCard(/Cache delivery slot lookups/)).getByTitle("You have it")).toBeTruthy();
  });

  it("says why a Take failed and leaves the card as it was", async () => {
    const user = userEvent.setup();
    await openInbox({
      handlers: {
        [takeOnPath(SLOTS)]: {
          status: 409,
          body: buildErrorBody("conflict", "It changed while the Task was being made."),
        },
      },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Take it",
    );

    expect(
      await screen.findByText(
        "Review #3 was not taken on: It changed while the Task was being made. Try again.",
      ),
    ).toBeTruthy();
    expect(within(getCard(/Cache delivery slot lookups/)).queryByTitle("You have it")).toBeNull();
  });

  it("dismisses a card before the controller answers, and Undo brings it back", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls } = await openInbox({
      handlers: {
        [dismissPath(SLOTS)]: held.handler,
        [restorePath(SLOTS)]: { body: {} },
      },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Dismiss",
    );

    // The controller has not answered, and the card is gone already, with the next one in its place.
    expect(screen.queryByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeNull();
    expect(screen.getByRole("listitem", { name: /Round loyalty points down/ })).toBeTruthy();
    expect(screen.getByText("Dismissed Review #3.")).toBeTruthy();
    held.answer({ body: {} });

    await user.click(getUndoButton());

    expect(await screen.findByText("Put back: Dismissed Review #3.")).toBeTruthy();
    expect(listCallsTo(calls, restorePath(SLOTS))).toHaveLength(1);
    expect(
      within(screen.getByRole("complementary", { name: "Requests" })).getByRole("listitem", {
        name: /Cache delivery slot lookups/,
      }),
    ).toBeTruthy();
  });

  it("puts a card back and says why when the controller refuses to dismiss it", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      handlers: {
        [dismissPath(SLOTS)]: { status: 500, body: buildErrorBody("internal", "Disk is full.") },
      },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Dismiss",
    );

    expect(
      await screen.findByText(
        "Review #3 was not dismissed, so it is back: Disk is full. Try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeTruthy();
    // A move that did not save has nothing to undo.
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(listCallsTo(calls, dismissPath(SLOTS))).toHaveLength(1);
  });

  it("dismisses with E and makes the next card that waits current, chosen by the order of the page", async () => {
    const user = userEvent.setup();
    const third = review(5, "Pin the checkout copy");
    await openInbox({
      inbox: () => buildPageInbox([ROUNDING, SLOTS, LOYALTY, third]),
      handlers: { [dismissPath(SLOTS)]: { body: {} } },
    });
    await screen.findByText("Fix the basket rounding");

    // The first arrow lands on the first card of the page, the next crosses to the column.
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(getCard(/Cache delivery slot lookups/).getAttribute("data-current")).toBe("keys");
    await user.keyboard("e");

    expect(screen.queryByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeNull();
    const next = getCard(/Round loyalty points down/);
    expect(next.getAttribute("data-current")).toBe("keys");
    expect(document.activeElement).toBe(next);
    // Exactly one card carries the mark.
    expect(document.querySelectorAll("[data-current]")).toHaveLength(1);
  });

  it("takes on with T and moves on, and refuses T on a card that has a Task, saying why", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      inbox: () => buildPageInbox([ROUNDING, SLOTS, LOYALTY]),
      handlers: { [takeOnPath(SLOTS)]: { body: { taskId: TASK_ID, created: true } } },
    });
    await screen.findByText("Fix the basket rounding");
    await user.keyboard("{ArrowDown}{ArrowRight}t");

    await screen.findByText("Took on Review #3. A Task is on Work.");
    expect(getCard(/Round loyalty points down/).getAttribute("data-current")).toBe("keys");

    // The card just taken keeps its place and now has a Task: walking back to it and pressing T refuses.
    await user.keyboard("{ArrowUp}t");
    expect(await screen.findByText("It already has a Task. Press G to see it.")).toBeTruthy();
    expect(listCallsTo(calls, takeOnPath(SLOTS))).toHaveLength(1);
  });

  it("does not act on a card from a key pressed in the toolbar or in a menu", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      handlers: {
        [dismissPath(SLOTS)]: { body: {} },
        [takeOnPath(SLOTS)]: { body: { taskId: TASK_ID, created: true } },
      },
    });
    await screen.findByText("Fix the basket rounding");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(getCard(/Cache delivery slot lookups/).getAttribute("data-current")).toBe("keys");

    // Focus is on the Group by button in the toolbar.
    screen.getByRole("button", { name: /Group by/ }).focus();
    await user.keyboard("et");
    // Focus is inside an open menu.
    await user.click(screen.getByRole("button", { name: /Group by/ }));
    await user.keyboard("et");

    expect(screen.getByRole("listitem", { name: /Cache delivery slot lookups/ })).toBeTruthy();
    expect(listCallsTo(calls, dismissPath(SLOTS))).toHaveLength(0);
    expect(listCallsTo(calls, takeOnPath(SLOTS))).toHaveLength(0);
  });

  it("walks with the arrows and J and K, and the opposite arrow comes straight back", async () => {
    const user = userEvent.setup();
    await openInbox({ inbox: () => buildPageInbox([ROUNDING, RETRIES, SLOTS, LOYALTY]) });
    await screen.findByText("Fix the basket rounding");
    const currentTitle = (): string | null =>
      document.querySelector("[data-current] .row-title, [data-current] .request-title")
        ?.textContent ?? null;

    // The surfaces lie by name: Checkout, then Pricing rules.
    await user.keyboard("{ArrowDown}");
    expect(currentTitle()).toBe("Retry card payments once");
    await user.keyboard("{ArrowDown}");
    expect(currentTitle()).toBe("Fix the basket rounding");
    // Down stays on the wide side: at its foot, nothing moves.
    await user.keyboard("{ArrowDown}");
    expect(currentTitle()).toBe("Fix the basket rounding");
    await user.keyboard("{ArrowRight}");
    expect(currentTitle()).toBe("Cache delivery slot lookups");
    await user.keyboard("{ArrowLeft}");
    expect(currentTitle()).toBe("Fix the basket rounding");
    // J and K read through the whole page.
    await user.keyboard("jj");
    expect(currentTitle()).toBe("Round loyalty points down");
    await user.keyboard("k");
    expect(currentTitle()).toBe("Cache delivery slot lookups");
  });

  it("says G has no Task for a card that waits, and goes to Work with the Task shown for one that has it", async () => {
    const user = userEvent.setup();
    const held = ticket(7, "Hold the courier slot", { taskId: TASK_ID });
    const { router } = await openInbox({
      inbox: () => buildPageInbox([ROUNDING, held]),
      handlers: {
        "GET /api/v1/tasks/board": {
          body: buildBoard(buildCard(TASK_ID, { title: "Hold the courier slot" })),
        },
        "GET /api/v1/tasks": { body: { items: [] } },
      },
    });
    await screen.findByText("Fix the basket rounding");
    await user.keyboard("{ArrowDown}g");

    expect(
      await screen.findByText("It has no Task yet. Press T to take it on, and G to see the Task."),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe("/inbox");

    await user.keyboard("{ArrowDown}g");

    // Work brings the Task's card into view and puts the keyboard on it.
    const workCard = await screen.findByRole("button", { name: /^Hold the courier slot/ });
    await waitFor(() => {
      expect(document.activeElement).toBe(workCard);
    });
    expect(router.state.location.pathname).toBe("/work");
  });

  it("undoes a dismissal with the Undo key from another screen, and the card is back when the Inbox opens", async () => {
    const user = userEvent.setup();
    const { calls, router } = await openInbox({
      handlers: {
        [dismissPath(SLOTS)]: { body: {} },
        [restorePath(SLOTS)]: { body: {} },
        "GET /api/v1/tasks/board": {
          body: buildBoard(buildCard(buildCardId(901), { title: "Order the depot labels" })),
        },
        "GET /api/v1/tasks": { body: { items: [] } },
      },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Dismiss",
    );
    await screen.findByText("Dismissed Review #3.");
    await waitFor(() => {
      expect(listCallsTo(calls, dismissPath(SLOTS))).toHaveLength(1);
    });

    await router.navigate({ to: "/work", search: {} });
    await screen.findByRole("button", { name: /^Order the depot labels/ });
    await user.keyboard("{Meta>}z{/Meta}");

    await waitFor(() => {
      expect(listCallsTo(calls, restorePath(SLOTS))).toHaveLength(1);
    });
    expect(await screen.findByText("Put back: Dismissed Review #3.")).toBeTruthy();

    await router.navigate({ to: "/inbox" });
    expect(
      await screen.findByRole("listitem", { name: /Cache delivery slot lookups/ }),
    ).toBeTruthy();
  });
  it("hands the pointer's card to the next that waits, so the same click at the same spot dismisses it too", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      handlers: { [dismissPath(SLOTS)]: { body: {} }, [dismissPath(LOYALTY)]: { body: {} } },
    });
    await pressMove(
      user,
      await screen.findByRole("listitem", { name: /Cache delivery/ }),
      "Dismiss",
    );
    expect(getCard(/Round loyalty points down/).getAttribute("data-current")).toBe("pointer");

    // The click lands on no card at all: it is the same spot, and the next card is the pointer's.
    await user.click(document.querySelector(".inbox-scroll")!);

    await waitFor(() => {
      expect(listCallsTo(calls, dismissPath(LOYALTY))).toHaveLength(1);
    });
    expect(screen.queryByRole("listitem", { name: /Round loyalty points down/ })).toBeNull();
  });

  it("opens a card with a click and with Return, and Esc folds it back", async () => {
    const user = userEvent.setup();
    await openInbox({
      handlers: {
        [`GET /api/v1/external-entities/${SLOTS.id}`]: {
          body: {
            ...SLOTS,
            kindAvailable: true,
            places: [SHOP_WEB],
            edges: [],
            links: [],
            conflicts: [],
          },
        },
      },
    });
    await user.click(await screen.findByText("Cache delivery slot lookups"));
    expect(await screen.findByRole("dialog", { name: "Cache delivery slot lookups" })).toBeTruthy();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Cache delivery slot lookups" })).toBeNull();
    });
    // The card the sheet folded back into holds the keys, so Return opens it again.
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Cache delivery slot lookups" })).toBeTruthy();
  });

  it("lists its keys on a sheet, from the ? key and from the button at the end of the bar", async () => {
    const user = userEvent.setup();
    await openInbox();
    await screen.findByText("Fix the basket rounding");

    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Keys" });
    expect(within(sheet).getByText("Take it")).toBeTruthy();
    expect(within(sheet).getByText("Dismiss")).toBeTruthy();
    expect(within(sheet).getByText("Undo")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keys" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
  });
  it("brings in a card that a read adds, and leaves the cards that were there where they are", async () => {
    let cards: readonly InboxCard[] = [ROUNDING, SLOTS];
    const { live } = await openInbox({ inbox: () => buildPageInbox(cards) });
    const slots = await screen.findByRole("listitem", { name: /Cache delivery/ });
    await live.waitForFirstPushes();

    cards = [ROUNDING, SLOTS, LOYALTY];
    live.pushInvalidation("externalEntity");

    const arrived = await screen.findByRole("listitem", { name: /Round loyalty points down/ });
    expect(screen.getByRole("listitem", { name: /Cache delivery/ })).toBe(slots);
    expect(arrived.compareDocumentPosition(slots) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
