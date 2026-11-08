/**
 * Tests the landing of a signal through the rendered app: a `signal` push adds
 * a line to a card and moves no card; the drop falls first and the new words
 * come when it lands; a part that rides on a card gets the moment on its own
 * row and the lead does nothing; the first read, a card out of sight and
 * Reduce motion play less. jsdom has no layout and no Web Animations, so the
 * tests give the page one box for every element and watch the calls to
 * `animate`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { EntityLink, Inbox, InboxCard } from "@hercule/contract";
import {
  buildInbox,
  buildInboxCard,
  buildInboxLink,
  buildInboxPlace,
  buildRequestCard,
  buildSignalLine,
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
} from "../../../app/testing";

const PAGE_BOX = new DOMRect(0, 0, 400, 100);

beforeEach(() => {
  stubIntersectionObserver();
  // Motion is on: the duration tokens are not 0.
  document.documentElement.style.setProperty("--dur-2", "200ms");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.style.removeProperty("--dur-2");
  vi.restoreAllMocks();
});

/** Gives every element a box, so the page counts a card as on screen. */
const giveEveryElementABox = (): void => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(PAGE_BOX);
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue(
    Object.assign([PAGE_BOX], { item: () => PAGE_BOX }),
  );
};

const buildCardId = (n: number): string => `01a1b576-c999-7000-8000-${String(n).padStart(12, "0")}`;

const PRICING = buildInboxPlace("acme:project:pricing", "Pricing rules");
const INBOX_PATH = "GET /api/v1/external-entities/inbox";
const ACME = buildSourcePlugin("acme", "Acme", [
  { word: "acme/ticket", connect: "Tickets" },
  { word: "acme/review", card: "compact", pace: "fast", connect: "Reviews" },
]);
const COUNTS = { onTheClock: 3, requests: 1, withSomeoneElse: 0, newestArrival: 5 };

/** Returns what a card says last: this sentence, from the signal numbered `n`. */
const saying = (n: number, say: string): Pick<InboxCard, "signals"> => ({
  signals: { openCount: 1, kinds: [], latest: buildSignalLine(buildCardId(900 + n), say) },
});

const ticket = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildInboxCard(String(n), {
    id: buildCardId(n),
    title,
    identifier: `OPS-${String(n)}`,
    status: { shape: "ring", tone: "quiet", label: "Open" },
    ancestors: [PRICING.ref],
    ...overrides,
  });

const REFUNDS = ticket(1, "Refund a returned order");
const SLOTS = ticket(2, "Hold a delivery slot");
const REVIEW = buildRequestCard("3", {
  id: buildCardId(3),
  title: "Start the refund when the depot confirms",
  person: { name: "Ines" },
  reason: { say: "Ines asked for your review", tone: "plain" },
  ridesOn: REFUNDS.ref,
});

const buildPageInbox = (cards: readonly InboxCard[], links: readonly EntityLink[] = []): Inbox => ({
  ...buildInbox(cards, { places: [PRICING], links }),
  counts: COUNTS,
});

/** Opens the Inbox, which the controller answers with what `inbox` returns each time. */
const openInbox = async (inbox: () => Inbox) => {
  stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [INBOX_PATH]: () => ({ body: inbox() }),
    "GET /api/v1/external-entities/inbox/count": () => ({ body: COUNTS }),
    "GET /api/v1/plugins": { body: [ACME] },
    "GET /api/v1/connections": {
      body: { items: [buildSourceConnection(buildCardId(800), "acme/account")] },
    },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/inbox", retryFailedReads: true },
  );
  await screen.findByText(REFUNDS.title);
  await app.live.waitForFirstPushes();
  return app;
};

const getRow = (title: string): HTMLElement =>
  screen.getByRole("listitem", { name: new RegExp(title) });

const listRowTitles = (): readonly (string | null)[] =>
  Array.from(document.querySelectorAll(".inbox-row .row-title"), (title) => title.textContent);

/** Returns the drops that fall on the page now. */
const listDrops = (): readonly Element[] => [...document.querySelectorAll(".landing-drop")];

/** Returns the elements that were given a rim, one for each call that animated a pseudo-element. */
const listRimmed = (animate: MockInstance<Element["animate"]>): readonly unknown[] =>
  animate.mock.calls.flatMap((call, index) =>
    (call[1] as KeyframeAnimationOptions).pseudoElement === "::after"
      ? [animate.mock.contexts[index]]
      : [],
  );

describe("a signal landing on a card of the Inbox", () => {
  it("lets the drop fall first, then draws the new words, the rim and the new mark, and moves no card", async () => {
    giveEveryElementABox();
    const animate = vi.spyOn(Element.prototype, "animate");
    let inbox = buildPageInbox([{ ...REFUNDS, ...saying(1, "Tessa commented") }, SLOTS]);
    const { live } = await openInbox(() => inbox);
    const row = getRow(REFUNDS.title);
    const titles = listRowTitles();
    // The first read of the visit plays nothing, and marks nothing.
    expect(listDrops()).toEqual([]);
    expect(row.classList.contains("is-landed")).toBe(false);
    expect(row.querySelector(".card-fresh")).toBeNull();

    inbox = buildPageInbox([{ ...REFUNDS, ...saying(2, "Omar commented") }, SLOTS]);
    live.pushInvalidation("externalEntity");

    await waitFor(() => {
      expect(listDrops()).toHaveLength(1);
    });
    // The cause shows first: the drop is on the page, and the card still has its old words.
    expect(listDrops()[0]?.getAttribute("data-tone")).toBe("plain");
    expect(row.textContent).toContain("Tessa commented");
    expect(row.textContent).not.toContain("Omar commented");
    expect(row.querySelector(".card-fresh")).toBeNull();

    await waitFor(() => {
      expect(row.textContent).toContain("Omar commented");
    });
    // The same element, in the same place: a signal adds a line and moves nothing.
    expect(getRow(REFUNDS.title)).toBe(row);
    expect(listRowTitles()).toEqual(titles);
    expect(row.classList.contains("is-landed")).toBe(true);
    expect(row.querySelector(".card-fresh")).not.toBeNull();
    // The rim is one animation of the card's `::after`, and the old sentence rolls away in a clip.
    expect(listRimmed(animate)).toEqual([row]);
    expect(row.querySelector(".card-line-clip")).not.toBeNull();
    expect(row.querySelector(".row-context")?.classList.contains("is-rolling")).toBe(true);
  });

  it("lands on the row of a part that rides on a card, and the lead does nothing", async () => {
    giveEveryElementABox();
    const animate = vi.spyOn(Element.prototype, "animate");
    const links = [buildInboxLink(REFUNDS.ref, REVIEW.ref)];
    let inbox = buildPageInbox(
      [REFUNDS, SLOTS, { ...REVIEW, ...saying(1, "Ines asked for your review") }],
      links,
    );
    const { live } = await openInbox(() => inbox);
    const lead = getRow(REFUNDS.title);
    const part = document.querySelector<HTMLElement>(".inbox-part.is-asking")!;
    const titles = listRowTitles();

    inbox = buildPageInbox([REFUNDS, SLOTS, { ...REVIEW, ...saying(2, "Omar commented") }], links);
    live.pushInvalidation("externalEntity");

    await waitFor(() => {
      expect(listDrops()).toHaveLength(1);
    });
    expect(part.textContent).toContain("Ines asked for your review");
    await waitFor(() => {
      expect(part.textContent).toContain("Omar commented");
    });
    expect(document.querySelector(".inbox-part.is-asking")).toBe(part);
    expect(part.classList.contains("is-landed")).toBe(true);
    expect(part.querySelector(".card-fresh")).not.toBeNull();
    // The words of the part rise into place; the lead is not marked, knocked or rolled, and nothing moves.
    expect(listRimmed(animate)).toEqual([part]);
    const rising = animate.mock.contexts.filter((element) =>
      (element as Element).matches(".part-said"),
    );
    expect(rising).toHaveLength(1);
    expect(lead.classList.contains("is-landed")).toBe(false);
    expect(lead.style.transform).toBe("");
    expect(lead.querySelector(".card-line-clip")).toBeNull();
    expect(listRowTitles()).toEqual(titles);
  });

  it("changes the words of a card that is out of sight after the same time, with no drop and no rim", async () => {
    // jsdom reports no box for any element, as for one that is scrolled out of the page.
    const animate = vi.spyOn(Element.prototype, "animate");
    let inbox = buildPageInbox([{ ...REFUNDS, ...saying(1, "Tessa commented") }, SLOTS]);
    const { live } = await openInbox(() => inbox);
    const row = getRow(REFUNDS.title);

    inbox = buildPageInbox([{ ...REFUNDS, ...saying(2, "Omar commented") }, SLOTS]);
    live.pushInvalidation("externalEntity");

    await waitFor(() => {
      expect(row.textContent).toContain("Omar commented");
    });
    expect(listDrops()).toEqual([]);
    expect(animate).not.toHaveBeenCalled();
    expect(row.classList.contains("is-landed")).toBe(false);
    // It is still new news, so the mark waits for the pointer.
    expect(row.querySelector(".card-fresh")).not.toBeNull();
  });

  it("changes the words at once under Reduce motion: no drop, no knock, and a rim that only fades", async () => {
    document.documentElement.style.setProperty("--dur-2", "0s");
    giveEveryElementABox();
    const animate = vi.spyOn(Element.prototype, "animate");
    let inbox = buildPageInbox([{ ...REFUNDS, ...saying(1, "Tessa commented") }, SLOTS]);
    const { live } = await openInbox(() => inbox);
    const row = getRow(REFUNDS.title);

    inbox = buildPageInbox([{ ...REFUNDS, ...saying(2, "Omar commented") }, SLOTS]);
    live.pushInvalidation("externalEntity");

    await waitFor(() => {
      expect(row.textContent).toContain("Omar commented");
    });
    expect(listDrops()).toEqual([]);
    expect(row.classList.contains("is-landed")).toBe(true);
    // One animation, the rim, a plain fade of 900ms.
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({
      duration: 900,
      easing: "linear",
      pseudoElement: "::after",
    });
    expect(row.querySelector(".card-line-clip")).toBeNull();
    expect(row.style.transform).toBe("");
  });

  it("plays once for each signal that lands, and not again for a read that brings the same one", async () => {
    giveEveryElementABox();
    const animate = vi.spyOn(Element.prototype, "animate");
    let inbox = buildPageInbox([{ ...REFUNDS, ...saying(1, "Tessa commented") }, SLOTS]);
    const { live } = await openInbox(() => inbox);
    const row = getRow(REFUNDS.title);

    inbox = buildPageInbox([{ ...REFUNDS, ...saying(2, "Omar commented") }, SLOTS]);
    live.pushInvalidation("externalEntity");
    await waitFor(() => {
      expect(row.textContent).toContain("Omar commented");
    });
    const calls = animate.mock.calls.length;

    live.pushInvalidation("externalEntity");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(animate.mock.calls).toHaveLength(calls);
    expect(listDrops()).toHaveLength(1);
  });
});
