/**
 * Tests how the user looks at the Requests column, through the rendered app:
 * the one menu that sets Show, Group and Sort, the groups that fold, what the
 * column says when nothing is drawn, and what the current card does when the
 * view stops drawing it. jsdom has no popover API, so the menu is always in
 * the page: its items are found with `hidden: true`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EntityPlace, Inbox, InboxCard } from "@hercule/contract";
import {
  buildInbox,
  buildRequestCard,
  buildSourceConnection,
  buildSourcePlugin,
} from "@hercule/client-core/inbox/testing";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const buildCardId = (n: number): string => `01a1b576-c999-7000-8000-${String(n).padStart(12, "0")}`;

const buildRepository = (name: string): EntityPlace => ({
  ref: `acme:repository:${name}`,
  kind: "acme/repository",
  noun: "Repository",
  caption: "Acme repository",
  title: name,
  restricted: false,
});
const BILLING = buildRepository("billing-api");
const SHOP = buildRepository("shop-web");

const review = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildRequestCard(String(n), {
    id: buildCardId(n),
    title,
    ancestors: [SHOP.ref],
    person: { name: "Ines" },
    reason: { say: "Ines asked for your review", tone: "plain" },
    ...overrides,
  });

const INVOICES = review(1, "Round invoice totals", {
  ancestors: [BILLING.ref],
  person: { name: "Tessa" },
});
const TAXES = review(2, "Add the tax column", {
  ancestors: [BILLING.ref],
  person: { name: "Tessa" },
});
const SLOTS = review(3, "Cache delivery slot lookups");
const LOYALTY = review(4, "Round loyalty points down", { yours: true });

const COUNTS = { onTheClock: 0, requests: 4, withSomeoneElse: 0, newestArrival: 5 };
const INBOX_PATH = "GET /api/v1/external-entities/inbox";
const dismissPath = (card: InboxCard): string =>
  `POST /api/v1/external-entities/${card.id}/dismiss`;

const ACME = buildSourcePlugin("acme", "Acme", [
  { word: "acme/review", card: "compact", pace: "fast", connect: "Reviews people ask of you" },
]);

/** Opens the Inbox, which answers with `cards()` to each read. */
const openInbox = async (
  cards: () => readonly InboxCard[] = () => [INVOICES, TAXES, SLOTS, LOYALTY],
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  const inbox = (): Inbox => ({
    ...buildInbox(cards(), { places: [BILLING, SHOP] }),
    counts: COUNTS,
  });
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [INBOX_PATH]: () => ({ body: inbox() }),
    "GET /api/v1/external-entities/inbox/count": () => ({ body: COUNTS }),
    "GET /api/v1/plugins": { body: [ACME] },
    "GET /api/v1/connections": {
      body: { items: [buildSourceConnection(buildCardId(800), "acme/account")] },
    },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/inbox" },
  );
  await screen.findByText("Round loyalty points down");
  return { calls, ...app };
};

const listCallsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

const getColumn = (): HTMLElement => screen.getByRole("complementary", { name: "Requests" });

/** Returns the row named `name` in the section of the menu named `section`. */
const getChoice = (section: "Show" | "Group" | "Sort", name: string): HTMLElement =>
  within(screen.getByRole("group", { name: section, hidden: true })).getByRole("menuitemradio", {
    name,
    hidden: true,
  });

const getTrigger = (): HTMLElement =>
  within(getColumn()).getByRole("button", { name: /^Show, group and sort/ });

/** Puts the keyboard focus on the page, out of the menu, so the keys act on its cards. */
const focusPage = (): void => {
  act(() => {
    document.querySelector<HTMLElement>(".inbox-scroll")!.focus();
  });
};

/** Lists the titles of the requests the column draws, in order. */
const listDrawnTitles = (): string[] =>
  within(getColumn())
    .queryAllByRole("listitem")
    .map((item) => item.querySelector(".request-title")?.textContent ?? "");

describe("the Requests view menu", () => {
  it("offers Show, Group and Sort as three labelled sections, with the people of the requests and the defaults on", async () => {
    await openInbox();

    expect(getChoice("Show", "All").getAttribute("aria-checked")).toBe("true");
    expect(getChoice("Show", "Mine").getAttribute("aria-checked")).toBe("false");
    // Not yours, once each, by name: LOYALTY is yours and its person is not offered twice.
    const people = within(screen.getByRole("group", { name: "Show", hidden: true }))
      .getAllByRole("menuitemradio", { hidden: true })
      .map((row) => row.textContent);
    expect(people).toEqual(["All", "Mine", "Ines", "Tessa"]);
    expect(getChoice("Group", "None").getAttribute("aria-checked")).toBe("true");
    expect(getChoice("Sort", "Oldest first").getAttribute("aria-checked")).toBe("true");
    // Everything is the default, so the button shows no words.
    expect(getTrigger().textContent).toBe("");
    expect(getTrigger().getAttribute("aria-label")).toBe("Show, group and sort");
  });

  it("changes the view with each pick, says what is not the default, and draws it", async () => {
    const user = userEvent.setup();
    await openInbox();
    expect(listDrawnTitles()).toEqual([
      "Round invoice totals",
      "Add the tax column",
      "Cache delivery slot lookups",
      "Round loyalty points down",
    ]);

    await user.click(getChoice("Show", "Mine"));
    expect(listDrawnTitles()).toEqual(["Round loyalty points down"]);
    expect(getChoice("Show", "Mine").getAttribute("aria-checked")).toBe("true");
    expect(getChoice("Show", "All").getAttribute("aria-checked")).toBe("false");
    expect(getTrigger().textContent).toContain("Mine");

    await user.click(getChoice("Show", "Tessa"));
    expect(listDrawnTitles()).toEqual(["Round invoice totals", "Add the tax column"]);

    await user.click(getChoice("Sort", "Newest first"));
    expect(listDrawnTitles()).toEqual(["Add the tax column", "Round invoice totals"]);

    await user.click(getChoice("Group", "By place"));
    expect(getTrigger().textContent).toContain("Tessa · By place · Newest first");
    expect(within(getColumn()).getByRole("button", { name: /billing-api/ })).toBeTruthy();
  });

  it("keeps the choice for the next visit", async () => {
    const user = userEvent.setup();
    await openInbox();
    await user.click(getChoice("Show", "Mine"));
    await user.click(getChoice("Group", "By place"));

    cleanup();
    await openInbox();

    expect(getChoice("Show", "Mine").getAttribute("aria-checked")).toBe("true");
    expect(getChoice("Group", "By place").getAttribute("aria-checked")).toBe("true");
    expect(listDrawnTitles()).toEqual(["Round loyalty points down"]);
  });

  it("keeps the heading and the control, and says nothing matches, when Show leaves no request", async () => {
    const user = userEvent.setup();
    let cards: readonly InboxCard[] = [INVOICES, LOYALTY];
    const { live } = await openInbox(() => cards);
    await live.waitForFirstPushes();
    await user.click(getChoice("Show", "Tessa"));

    // Her last request goes. Her name stays in the menu, because it is the choice.
    cards = [LOYALTY];
    live.pushInvalidation("externalEntity");

    expect(await within(getColumn()).findByText("Nothing here matches this filter.")).toBeTruthy();
    expect(within(getColumn()).queryByText("No requests left.")).toBeNull();
    expect(getTrigger().textContent).toContain("Tessa");
    expect(getChoice("Show", "Tessa").getAttribute("aria-checked")).toBe("true");
  });
});

describe("the Requests groups", () => {
  const openGrouped = async (
    cards?: () => readonly InboxCard[],
    handlers?: Readonly<Record<string, Handler>>,
  ) => {
    const app = await openInbox(cards, handlers);
    await userEvent.setup().click(getChoice("Group", "By place"));
    return app;
  };

  const getControlledList = (header: HTMLElement): HTMLElement => {
    const list = document.getElementById(header.getAttribute("aria-controls") ?? "");
    if (list === null) throw new Error("The header's aria-controls names no element");
    return list;
  };

  it("folds a group to its header and count, with no card, and opens it again", async () => {
    const user = userEvent.setup();
    await openGrouped();
    const header = within(getColumn()).getByRole("button", { name: /billing-api/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toBe("billing-api");

    await user.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toBe("billing-api2");
    expect(listDrawnTitles()).toEqual(["Cache delivery slot lookups", "Round loyalty points down"]);
    // The header keeps the focus, and the list it controls stays in the page, hidden and holding no card.
    expect(document.activeElement).toBe(header);
    const folded = getControlledList(header);
    expect(folded.hidden).toBe(true);
    expect(folded.querySelector("[data-card-id]")).toBeNull();

    await user.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toBe("billing-api");
    expect(listDrawnTitles()).toHaveLength(4);
    expect(getControlledList(header).hidden).toBe(false);
  });

  it("shows the headers and counts, not the sunrise, when every group is folded", async () => {
    const user = userEvent.setup();
    await openGrouped();

    await user.click(within(getColumn()).getByRole("button", { name: /billing-api/ }));
    await user.click(within(getColumn()).getByRole("button", { name: /shop-web/ }));

    expect(listDrawnTitles()).toEqual([]);
    expect(within(getColumn()).getByRole("button", { name: /shop-web/ }).textContent).toBe(
      "shop-web2",
    );
    expect(within(getColumn()).queryByText("No requests left.")).toBeNull();
    expect(within(getColumn()).queryByText("Nothing here matches this filter.")).toBeNull();
  });

  it("keeps a folded group folded for the next visit", async () => {
    const user = userEvent.setup();
    await openGrouped();
    await user.click(within(getColumn()).getByRole("button", { name: /billing-api/ }));

    cleanup();
    await openInbox();

    expect(
      within(getColumn())
        .getByRole("button", { name: /billing-api/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(listDrawnTitles()).toEqual(["Cache delivery slot lookups", "Round loyalty points down"]);
  });

  it("lets go of the current card when its group folds, so E acts on no card", async () => {
    const user = userEvent.setup();
    const { calls } = await openGrouped(undefined, {
      [dismissPath(INVOICES)]: { body: {} },
    });
    focusPage();
    await user.keyboard("{ArrowDown}");
    const first = within(getColumn()).getByRole("listitem", { name: /Round invoice totals/ });
    expect(first.getAttribute("data-current")).toBe("keys");

    await user.click(within(getColumn()).getByRole("button", { name: /billing-api/ }));
    expect(document.querySelectorAll("[data-current]")).toHaveLength(0);
    await user.keyboard("e");

    expect(listCallsTo(calls, dismissPath(INVOICES))).toHaveLength(0);
    // The next walk starts from the top of the page again, not from the folded card.
    await user.keyboard("{ArrowDown}");
    expect(
      within(getColumn())
        .getByRole("listitem", { name: /Cache delivery slot lookups/ })
        .getAttribute("data-current"),
    ).toBe("keys");
  });

  it("lets go of the current card when Show stops drawing it, so E acts on no card", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox(undefined, { [dismissPath(INVOICES)]: { body: {} } });
    focusPage();
    await user.keyboard("{ArrowDown}");
    expect(
      within(getColumn())
        .getByRole("listitem", { name: /Round invoice totals/ })
        .getAttribute("data-current"),
    ).toBe("keys");

    await user.click(getChoice("Show", "Mine"));
    focusPage();
    await user.keyboard("e");

    expect(listCallsTo(calls, dismissPath(INVOICES))).toHaveLength(0);
  });
});

describe("a repeated dismissal", () => {
  it("does not dismiss the next card after the view changed, though the click is at the same spot", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox(undefined, {
      [dismissPath(INVOICES)]: { body: {} },
      [dismissPath(TAXES)]: { body: {} },
      [dismissPath(SLOTS)]: { body: {} },
      [dismissPath(LOYALTY)]: { body: {} },
    });
    const card = within(getColumn()).getByRole("listitem", { name: /Round invoice totals/ });
    await user.hover(card);
    await user.click(within(card).getByRole("button", { name: "Dismiss", hidden: true }));
    await waitFor(() => {
      expect(listCallsTo(calls, dismissPath(INVOICES))).toHaveLength(1);
    });

    // The menu is picked far from the spot, then a click lands on the spot of the dismissal again.
    fireEvent.click(getChoice("Sort", "Newest first"), { clientX: 200, clientY: 200 });
    fireEvent.click(document.querySelector(".inbox-scroll")!, { clientX: 0, clientY: 0 });

    // A dismissal takes its card off the page at once, before the controller answers.
    expect(within(getColumn()).getByRole("listitem", { name: /Add the tax column/ })).toBeTruthy();
    expect(listCallsTo(calls, dismissPath(TAXES))).toHaveLength(0);
  });
});
