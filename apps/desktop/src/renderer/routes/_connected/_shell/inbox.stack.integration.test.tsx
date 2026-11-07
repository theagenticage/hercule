/**
 * Tests what rides on a card of the Inbox, through the rendered app: a request
 * that rides on a ticket is drawn under it as a part and moves no card, the
 * quiet and locked parts, a hint that never stacks, `Link them` with its one
 * Undo, and what dismissing a lead does to what rode on it. The world is the
 * invented one of the Inbox tests: tickets under a project, reviews in a column.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EntityHint, EntityLink, EntityPeer, Inbox, InboxCard } from "@hercule/contract";
import {
  buildInbox,
  buildInboxCard,
  buildInboxHint,
  buildInboxLink,
  buildInboxPeer,
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

const PRICING = buildInboxPlace("acme:project:pricing", "Pricing rules");
const LINK_PATH = "POST /api/v1/external-entities/links";
const UNLINK_PATH = "POST /api/v1/external-entities/links/remove";
const INBOX_PATH = "GET /api/v1/external-entities/inbox";

const ticket = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildInboxCard(String(n), {
    id: buildCardId(n),
    title,
    identifier: `OPS-${String(n)}`,
    status: { shape: "ring", tone: "quiet", label: "Open" },
    ancestors: [PRICING.ref],
    ...overrides,
  });

const pullRequest = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildRequestCard(String(n), {
    id: buildCardId(n),
    title,
    person: { name: "Ines" },
    reason: { say: "Ines asked for your review", tone: "plain" },
    ...overrides,
  });

const REFUNDS = ticket(1, "Refund a returned order");
const SLOTS = ticket(2, "Hold a delivery slot");
const REVIEW = pullRequest(3, "Start the refund when the depot confirms");

const ACME = buildSourcePlugin("acme", "Acme", [
  { word: "acme/ticket", connect: "Tickets" },
  { word: "acme/review", card: "compact", pace: "fast", connect: "Reviews" },
]);

const COUNTS = { onTheClock: 3, requests: 1, withSomeoneElse: 0, newestArrival: 5 };

/** Returns the Inbox these cards make, with the links, peers and hints given. */
const buildPageInbox = (
  cards: readonly InboxCard[],
  links: readonly EntityLink[] = [],
  peers: readonly EntityPeer[] = [],
  hints: readonly EntityHint[] = [],
): Inbox => ({
  ...buildInbox(cards, { places: [PRICING], links, hints, peers }),
  counts: COUNTS,
});

/** Opens the Inbox, which the controller answers with what `inbox` returns each time. */
const openInbox = async (inbox: () => Inbox, handlers: Readonly<Record<string, Handler>> = {}) => {
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
    {
      path: "/inbox",
      retryFailedReads: true,
    },
  );
  return { calls, ...app };
};

const listCallsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

const getRequests = (): HTMLElement => screen.getByRole("complementary", { name: "Requests" });

/** Returns the rows of lasting work on the page, in the order the page draws them. */
const listRowTitles = (): readonly (string | undefined)[] =>
  Array.from(
    document.querySelectorAll(".inbox-row .row-title"),
    (title) => title.textContent ?? undefined,
  );

describe("what rides on a card of the Inbox", () => {
  it("draws a request that rides on a ticket as a part under it, leaves Requests, and moves no row", async () => {
    const riding = { ...REVIEW, ridesOn: REFUNDS.ref };
    const links = [buildInboxLink(REFUNDS.ref, REVIEW.ref)];
    await openInbox(() => buildPageInbox([REFUNDS, SLOTS, riding], links));

    const tucked = await screen.findByRole("group", { name: "Riding on Refund a returned order" });
    // It asks first, then says what it is, and it is a card of its own with its own moves.
    expect(within(tucked).getByText("Ines asked for your review")).toBeTruthy();
    expect(within(tucked).getByText("Start the refund when the depot confirms")).toBeTruthy();
    const part = tucked.querySelector<HTMLElement>(".inbox-part.is-asking")!;
    expect(part.dataset["cardId"]).toBe(REVIEW.id);
    expect(within(part).getByRole("button", { name: "Take it", hidden: true })).toBeTruthy();
    // The claim is the part's tooltip.
    expect(part.getAttribute("title")).toBe("Acme reports this");
    // Nothing moved: the rows keep their order, and the request is no longer in the column.
    expect(listRowTitles()).toEqual(["Refund a returned order", "Hold a delivery slot"]);
    expect(within(getRequests()).queryByText(/Start the refund/)).toBeNull();
    // It follows its lead in the page's order, and the row says how many ride on it.
    expect(
      screen.getByRole("listitem", { name: /Refund a returned order.*1 thing riding on it/ }),
    ).toBeTruthy();
    expect(tucked.closest(".inbox-bundle")!.querySelector(".inbox-row")).not.toBeNull();
  });

  it("draws the other lasting thing and a thing nobody can read as quiet and locked parts, which are no cards", async () => {
    const hidden = buildInboxPeer("sentry:issue:9", {
      kind: "sentry/issue",
      noun: "Issue",
      restricted: true,
    });
    const quiet = buildInboxPeer("acme:ticket:77", {
      id: buildCardId(77),
      title: "Clear the cache",
      status: { shape: "ring", tone: "active", label: "In Progress" },
    });
    await openInbox(() =>
      buildPageInbox(
        [REFUNDS],
        [buildInboxLink(REFUNDS.ref, hidden.ref), buildInboxLink(REFUNDS.ref, quiet.ref, "person")],
        [hidden, quiet],
      ),
    );

    const tucked = await screen.findByRole("group", { name: "Riding on Refund a returned order" });
    const parts = Array.from(tucked.querySelectorAll<HTMLElement>(".inbox-part"));
    expect(parts[0]!.querySelector(".part-title")?.textContent).toBe("Clear the cache");
    expect(parts[0]!.querySelector(".part-said")?.textContent).toBe("In Progress");
    // A locked part names the kind of thing and never a title.
    expect(parts[1]!.querySelector(".part-title")?.textContent).toBe(
      "A sentry issue you cannot open",
    );
    expect(parts[1]!.getAttribute("title")).toBe("Acme reports this");
    expect(parts[0]!.getAttribute("title")).toBe("You linked this");
    // Neither is a card: no id, no moves, and the page's keys never stop on them.
    for (const part of parts) {
      expect(part.dataset["cardId"]).toBeUndefined();
      expect(within(part).queryByRole("button", { name: "Take it", hidden: true })).toBeNull();
    }
    // The quiet part opens what is behind it.
    expect(parts[0]!.dataset["openId"]).toBe(buildCardId(77));
    expect(parts[1]!.dataset["openId"]).toBeUndefined();
  });

  it("says Mentions and Mentioned in under the two ends of a reference found in text, and never stacks them", async () => {
    const mentioner = pullRequest(3, "Start the refund when the depot confirms", {
      identifier: "#6263",
    });
    await openInbox(() =>
      buildPageInbox([REFUNDS, mentioner], [], [], [buildInboxHint(mentioner.ref, REFUNDS.ref)]),
    );

    await screen.findByText("Mentions OPS-1");
    expect(screen.getByText("Mentioned in #6263")).toBeTruthy();
    // A hint joins nothing: the request stays in its column, and the ticket carries no part.
    expect(
      within(getRequests()).getByText("Start the refund when the depot confirms"),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Riding on/ })).toBeNull();
    // Its tooltip says where the reference was found.
    expect(screen.getByText("Mentions OPS-1").closest("button")!.getAttribute("title")).toBe(
      "Found in the description of #6263",
    );
  });
});

describe("Link them", () => {
  /** A controller that holds what a link does: the request rides on the ticket once it is linked. */
  const holdLinks = () => {
    let linked = false;
    return {
      inbox: (): Inbox => {
        const request = pullRequest(3, "Start the refund when the depot confirms", {
          identifier: "#6263",
          ...(linked ? { ridesOn: REFUNDS.ref } : {}),
        });
        return buildPageInbox(
          [REFUNDS, SLOTS, request],
          linked ? [buildInboxLink(request.ref, REFUNDS.ref, "person")] : [],
          [],
          linked ? [] : [buildInboxHint(request.ref, REFUNDS.ref)],
        );
      },
      links: (): Handler => () => {
        linked = true;
        return { body: {} };
      },
      unlinks: (): Handler => () => {
        linked = false;
        return { body: { removed: true, remaining: "text" } };
      },
    };
  };

  it("links the pair, moves the request into the ticket's sheet at once, and Undo takes it out again", async () => {
    const user = userEvent.setup();
    const server = holdLinks();
    const { calls } = await openInbox(server.inbox, {
      [LINK_PATH]: server.links(),
      [UNLINK_PATH]: server.unlinks(),
    });

    await user.click((await screen.findByText("Mentions OPS-1")).closest("button")!);

    // One call, naming the pair as the reference reads.
    await waitFor(() => {
      expect(listCallsTo(calls, LINK_PATH)).toHaveLength(1);
    });
    expect(listCallsTo(calls, LINK_PATH)[0]?.body).toEqual({
      fromRef: "acme:review:3",
      toRef: REFUNDS.ref,
    });
    const tucked = await screen.findByRole("group", { name: "Riding on Refund a returned order" });
    expect(tucked.querySelector<HTMLElement>(".inbox-part")?.dataset["cardId"]).toBe(
      buildCardId(3),
    );
    expect(within(getRequests()).queryByText(/Start the refund/)).toBeNull();
    expect(screen.getByText("Linked #6263 and OPS-1.")).toBeTruthy();
    // The hint is gone with the claim that made it: the pair is linked now.
    expect(screen.queryByText("Mentions OPS-1")).toBeNull();
    expect(listRowTitles()).toEqual(["Refund a returned order", "Hold a delivery slot"]);

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    await waitFor(() => {
      expect(listCallsTo(calls, UNLINK_PATH)).toHaveLength(1);
    });
    expect(listCallsTo(calls, UNLINK_PATH)[0]?.body).toEqual({
      fromRef: "acme:review:3",
      toRef: REFUNDS.ref,
    });
    // The request is back in its column and the hint is back under it.
    expect(
      await within(getRequests()).findByText("Start the refund when the depot confirms"),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Riding on/ })).toBeNull();
    expect(await screen.findByText("Mentions OPS-1")).toBeTruthy();
  });

  it("puts the request back and says why when the controller refuses the link", async () => {
    const user = userEvent.setup();
    const server = holdLinks();
    await openInbox(server.inbox, {
      [LINK_PATH]: () => ({
        status: 500,
        body: { _tag: "Internal", message: "The controller could not link them." },
      }),
    });

    await user.click((await screen.findByText("Mentions OPS-1")).closest("button")!);

    expect(await screen.findByText(/were not linked/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Riding on/ })).toBeNull();
    expect(
      within(getRequests()).getByText("Start the refund when the depot confirms"),
    ).toBeTruthy();
  });
});

describe("dismissing a lead", () => {
  it("lets what rode on it stand alone, says so on the undo line, and takes it back on Undo", async () => {
    const user = userEvent.setup();
    const riding = { ...REVIEW, ridesOn: REFUNDS.ref };
    const link = buildInboxLink(REFUNDS.ref, REVIEW.ref);
    // What the controller holds: a dismissed lead is off the Inbox, and what rode on it rides on nothing.
    let isDismissed = false;
    await openInbox(
      () =>
        isDismissed
          ? buildPageInbox([SLOTS, REVIEW])
          : buildPageInbox([REFUNDS, SLOTS, riding], [link]),
      {
        [`POST /api/v1/external-entities/${REFUNDS.id}/dismiss`]: () => {
          isDismissed = true;
          return { body: {} };
        },
        [`POST /api/v1/external-entities/${REFUNDS.id}/restore`]: () => {
          isDismissed = false;
          return { body: {} };
        },
      },
    );

    const lead = await screen.findByRole("listitem", { name: /Refund a returned order/ });
    await user.hover(lead);
    await user.click(within(lead).getByRole("button", { name: "Dismiss", hidden: true }));

    expect(
      await screen.findByText("Dismissed Ticket OPS-1. Review #3 stands alone now."),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Riding on/ })).toBeNull();
    expect(
      within(getRequests()).getByText("Start the refund when the depot confirms"),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByRole("group", { name: "Riding on Refund a returned order" }),
    ).toBeTruthy();
    expect(within(getRequests()).queryByText(/Start the refund/)).toBeNull();
  });
});
