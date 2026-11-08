/**
 * Tests handing a card of the Inbox to a workflow, through the rendered app:
 * the one workflow that fits and the menu of several, the Task the answer
 * brings, a refusal that puts the card back with its reason, the three
 * answers to Undo (taken back, asked to stop, too late), a double click that
 * starts one run, and carrying a card onto another to link the two. The world
 * is the invented one of the Inbox tests: tickets under a project, reviews in
 * a column.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HandOffUndo, Inbox, InboxCard, WorkflowOffer } from "@hercule/contract";
import {
  buildInbox,
  buildInboxCard,
  buildInboxPlace,
  buildRequestCard,
  buildSourceConnection,
  buildSourcePlugin,
  buildWorkflowOffer,
} from "@hercule/client-core/inbox/testing";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  holdAnswer,
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

const buildId = (n: number): string => `01a1b576-c999-7000-8000-${String(n).padStart(12, "0")}`;

const PRICING = buildInboxPlace("acme:project:pricing", "Pricing rules");
const INBOX_PATH = "GET /api/v1/external-entities/inbox";
const LINK_PATH = "POST /api/v1/external-entities/links";
const UNLINK_PATH = "POST /api/v1/external-entities/links/remove";

const BOT = { id: buildId(701), label: "northwind-bot" };
const AVA = { id: buildId(702), label: "ava-northwind" };
const RUN_ID = buildId(901);
const TASK_ID = buildId(902);

/** Returns an offer for the workflow numbered `n`, which answers `answers`. */
const buildOffer = (n: number, name: string, answers: readonly string[]): WorkflowOffer => ({
  ...buildWorkflowOffer(name, answers),
  workflowId: buildId(800 + n),
});

const REVIEW_OFFER = buildOffer(1, "Agent review", ["acme/review-requested"]);
const REPAIR_OFFER = buildOffer(2, "Repair the build", ["acme/checks-failed"]);

const ticket = (n: number, title: string, overrides: Partial<InboxCard> = {}): InboxCard =>
  buildInboxCard(String(n), {
    id: buildId(n),
    title,
    identifier: `OPS-${String(n)}`,
    status: { shape: "ring", tone: "quiet", label: "Open" },
    ancestors: [PRICING.ref],
    offerSetId: "one",
    actingConnections: [BOT],
    signals: { openCount: 1, kinds: ["acme/review-requested", "acme/mention"] },
    ...overrides,
  });

const REFUNDS = ticket(1, "Refund a returned order");
const SLOTS = ticket(2, "Hold a delivery slot", { offerSetId: "several" });
const BASKET = ticket(3, "Round the basket total");
const REVIEW = buildRequestCard("4", {
  id: buildId(4),
  title: "Start the refund when the depot confirms",
  person: { name: "Ines" },
  reason: { say: "Ines asked for your review", tone: "plain" },
  offerSetId: "one",
  actingConnections: [BOT],
});

const ACME = buildSourcePlugin("acme", "Acme", [
  { word: "acme/ticket", connect: "Tickets" },
  { word: "acme/review", card: "compact", pace: "fast", connect: "Reviews" },
]);

const COUNTS = { onTheClock: 3, requests: 1, withSomeoneElse: 0, newestArrival: 5 };

const buildPageInbox = (cards: readonly InboxCard[]): Inbox => ({
  ...buildInbox(cards, {
    places: [PRICING],
    offerSets: {
      one: [REVIEW_OFFER],
      several: [REVIEW_OFFER, REPAIR_OFFER],
      none: [],
    },
  }),
  counts: COUNTS,
});

const handOffPath = (card: InboxCard): string =>
  `POST /api/v1/external-entities/${card.id}/hand-off`;
const undoPath = `POST /api/v1/external-entities/handoffs/${RUN_ID}/undo`;

/**
 * Opens the Inbox, which the controller answers with `cards`. A card whose
 * hand-off the controller answered has the Task from then on, as the real
 * controller holds it: the page reads the Inbox again after the answer, and a
 * stub that kept the old cards would take the Task away again.
 */
const openInbox = async (
  handlers: Readonly<Record<string, Handler>>,
  cards: readonly InboxCard[] = [REFUNDS, SLOTS, BASKET, REVIEW],
) => {
  const handedIds = new Set<string>();
  const holdHandOffs = Object.fromEntries(
    cards.flatMap((card): [string, Handler][] => {
      const answer = handlers[handOffPath(card)];
      if (answer === undefined) return [];
      return [
        [
          handOffPath(card),
          async (call) => {
            const reply = typeof answer === "function" ? await answer(call) : answer;
            if (reply.status === undefined) handedIds.add(card.id);
            return reply;
          },
        ],
      ];
    }),
  );
  // A hand-off that was taken back deleted the Task it made.
  const undoAnswer = handlers[undoPath];
  const holdUndo: Record<string, Handler> =
    undoAnswer === undefined
      ? {}
      : {
          [undoPath]: async (call) => {
            const reply = typeof undoAnswer === "function" ? await undoAnswer(call) : undoAnswer;
            if ((reply.body as HandOffUndo).outcome === "undone") handedIds.clear();
            return reply;
          },
        };
  const heldCards = (): readonly InboxCard[] =>
    cards.map((card) =>
      handedIds.has(card.id) ? { ...card, side: "with-someone-else", taskId: TASK_ID } : card,
    );
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [INBOX_PATH]: () => ({ body: buildPageInbox(heldCards()) }),
    "GET /api/v1/external-entities/inbox/count": () => ({ body: COUNTS }),
    "GET /api/v1/plugins": { body: [ACME] },
    "GET /api/v1/connections": {
      body: { items: [buildSourceConnection(buildId(800), "acme/account")] },
    },
    ...handlers,
    ...holdHandOffs,
    ...holdUndo,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/inbox", retryFailedReads: true },
  );
  return { calls, ...app };
};

const listCallsTo = (calls: readonly Call[], path: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path);

const getCard = (title: string): HTMLElement =>
  screen.getByRole("listitem", { name: new RegExp(title) });

const HAND_MENU = '[role="menu"][aria-label="Hand to"]';

/** Waits for the Hand to menu to open and returns it. A role query would be slow on a page this size. */
const findHandMenu = (): Promise<HTMLElement> =>
  waitFor(() => {
    const menu = document.querySelector<HTMLElement>(HAND_MENU);
    if (menu === null) throw new Error("The Hand to menu is not open.");
    return menu;
  });

/** Rests the pointer on a card, which shows its moves, and returns its move named `name`. */
const hoverMove = async (
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
  name: string,
): Promise<HTMLElement> => {
  await user.hover(card);
  return within(card).getByRole("button", { name, hidden: true });
};

const HANDED = { runId: RUN_ID, taskId: TASK_ID };
const HAND_OFF_LINE = "Handed Ticket OPS-1 to Agent review. Its Task is on Work.";

/** Hands the first ticket to the one workflow that fits it and waits for the answer to be drawn. */
const handRefunds = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByText("Refund a returned order");
  await user.click(
    await hoverMove(user, getCard("Refund a returned order"), "Hand to Agent review"),
  );
  await screen.findByText(HAND_OFF_LINE);
};

const UNDO_OF: Readonly<Record<HandOffUndo["outcome"], HandOffUndo>> = {
  undone: {
    outcome: "undone",
    stopRequested: true,
    taskRemoved: true,
    stageRestored: false,
    failureRestored: false,
  },
  stopped: {
    outcome: "stopped",
    stopRequested: true,
    taskRemoved: false,
    stageRestored: false,
    failureRestored: false,
    reason: "The run had already started a step.",
  },
  "too-late": {
    outcome: "too-late",
    stopRequested: false,
    taskRemoved: false,
    stageRestored: false,
    failureRestored: false,
  },
};

describe("handing a card to a workflow", () => {
  it("hands the card to its one workflow on a click: the colleague has it, the answer's Task lands, and the controller picks the account", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({ [handOffPath(REFUNDS)]: { body: HANDED } });

    await handRefunds(user);

    // The user chose no account, so none is sent and the controller uses the default.
    expect(listCallsTo(calls, handOffPath(REFUNDS))[0]?.body).toEqual({
      workflowId: REVIEW_OFFER.workflowId,
    });
    const card = getCard("Refund a returned order");
    expect(within(card).getByRole("img", { name: "Agent review has it" })).toBeTruthy();
    expect(card.textContent).toContain("Agent review has it");
    // The Task came with the answer, so the card offers it where Take it was.
    expect(card.hasAttribute("data-has-task")).toBe(true);
    expect(within(card).getByRole("button", { name: "On Work", hidden: true })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Take it", hidden: true })).toBeNull();
  });

  it("hands on H when one workflow fits, and says why when none does", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({ [handOffPath(REFUNDS)]: { body: HANDED } }, [
      REFUNDS,
      ticket(5, "Reprice the loyalty tiers", { offerSetId: "none" }),
    ]);
    await screen.findByText("Refund a returned order");

    await user.hover(getCard("Reprice the loyalty tiers"));
    await user.keyboard("h");
    expect(await screen.findByText(/No workflow takes a ticket/)).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(REFUNDS))).toHaveLength(0);

    await user.hover(getCard("Refund a returned order"));
    await user.keyboard("h");

    expect(await screen.findByText(HAND_OFF_LINE)).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(REFUNDS))).toHaveLength(1);
  });

  it("opens a menu when several fit, and the number key picks a workflow", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({ [handOffPath(SLOTS)]: { body: HANDED } });
    await screen.findByText("Hold a delivery slot");
    const card = getCard("Hold a delivery slot");

    await user.click(await hoverMove(user, card, "Hand to…"));

    const menu = await findHandMenu();
    expect(within(menu).getByText("Agent review")).toBeTruthy();
    expect(within(menu).getByText("Repair the build")).toBeTruthy();
    // The line under each workflow says what the click ends and what it leaves.
    expect(within(menu).getByText("Ends Review requested. Mention stays open.")).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(SLOTS))).toHaveLength(0);

    await user.keyboard("2");

    await waitFor(() => {
      expect(listCallsTo(calls, handOffPath(SLOTS))).toHaveLength(1);
    });
    expect(listCallsTo(calls, handOffPath(SLOTS))[0]?.body).toEqual({
      workflowId: REPAIR_OFFER.workflowId,
    });
    expect(
      await screen.findByText("Handed Ticket OPS-2 to Repair the build. Its Task is on Work."),
    ).toBeTruthy();
    expect(document.querySelector(HAND_MENU)).toBeNull();
  });

  it("acts as the account the user picks in the menu", async () => {
    const user = userEvent.setup();
    const several = ticket(2, "Hold a delivery slot", {
      offerSetId: "several",
      actingConnections: [BOT, AVA],
    });
    const { calls } = await openInbox({ [handOffPath(several)]: { body: HANDED } }, [several]);
    await screen.findByText("Hold a delivery slot");

    await user.click(await hoverMove(user, getCard("Hold a delivery slot"), "Hand to…"));
    const menu = await findHandMenu();
    await user.selectOptions(menu.querySelector("select")!, AVA.id);
    await user.click(menu.querySelector("[data-hand-row='0']")!);

    await waitFor(() => {
      expect(listCallsTo(calls, handOffPath(several))).toHaveLength(1);
    });
    expect(listCallsTo(calls, handOffPath(several))[0]?.body).toEqual({
      workflowId: REVIEW_OFFER.workflowId,
      connectionId: AVA.id,
    });
  });

  it("sends one request for a double click", async () => {
    const user = userEvent.setup();
    const held = holdAnswer();
    const { calls } = await openInbox({ [handOffPath(REFUNDS)]: held.handler });
    await screen.findByText("Refund a returned order");

    await user.dblClick(
      await hoverMove(user, getCard("Refund a returned order"), "Hand to Agent review"),
    );

    // The colleague has the card at once, before the controller answers.
    expect(
      within(getCard("Refund a returned order")).getByRole("img", { name: "Agent review has it" }),
    ).toBeTruthy();
    held.answer({ body: HANDED });
    expect(await screen.findByText(HAND_OFF_LINE)).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(REFUNDS))).toHaveLength(1);
  });

  it("puts the card back and says why when the controller refuses, also when the workflow is already working", async () => {
    const user = userEvent.setup();
    await openInbox({
      [handOffPath(REFUNDS)]: {
        status: 409,
        body: buildErrorBody("invalid_state", "Agent review is already working on this."),
      },
    });
    await screen.findByText("Refund a returned order");

    await user.click(
      await hoverMove(user, getCard("Refund a returned order"), "Hand to Agent review"),
    );

    expect(
      await screen.findByText(
        "Ticket OPS-1 was not handed to Agent review. Agent review is already working on this.",
      ),
    ).toBeTruthy();
    const card = getCard("Refund a returned order");
    expect(within(card).queryByRole("img", { name: "Agent review has it" })).toBeNull();
    expect(card.hasAttribute("data-has-task")).toBe(false);
    expect(within(card).getByRole("button", { name: "Take it", hidden: true })).toBeTruthy();
  });
});

/** Returns what `externalEntity.read` answers for `card`: it can be handed to the review workflow, as `BOT`. */
const buildDetailAnswer = (
  card: InboxCard,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, Handler> => ({
  [`GET /api/v1/external-entities/${card.id}`]: {
    body: {
      ...card,
      kindAvailable: true,
      places: [PRICING],
      edges: [{ fromRef: card.ref, toRef: PRICING.ref }],
      links: [],
      hints: [],
      conflicts: [],
      signals: [],
      openCount: 0,
      signalCount: 0,
      timeline: [],
      peers: [],
      offers: [REVIEW_OFFER],
      actingConnections: [BOT],
      ...overrides,
    },
  },
});

/** Opens the card titled `title` with a click and waits until the moves in its sheet take a pointer. */
const openSheetOf = async (
  user: ReturnType<typeof userEvent.setup>,
  title: string,
): Promise<HTMLElement> => {
  await user.click(await screen.findByText(title));
  const sheet = await screen.findByRole("dialog", { name: title });
  await waitFor(() => {
    expect(sheet.querySelector("[data-arming]")).toBeNull();
  });
  return sheet;
};

describe("handing a card from its open sheet", () => {
  it("hands on H to the one workflow the sheet lists, and the controller picks the account", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      ...buildDetailAnswer(REFUNDS),
      [handOffPath(REFUNDS)]: { body: HANDED },
    });
    await screen.findByText("Refund a returned order");
    const sheet = await openSheetOf(user, "Refund a returned order");
    await within(sheet).findByRole("button", { name: /^Agent review/ });

    await user.keyboard("h");

    expect(await screen.findByText(HAND_OFF_LINE)).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(REFUNDS))[0]?.body).toEqual({
      workflowId: REVIEW_OFFER.workflowId,
    });
  });

  it("says why on H when no workflow can take the card, as the page does", async () => {
    const user = userEvent.setup();
    const none = ticket(5, "Reprice the loyalty tiers", { offerSetId: "none" });
    const { calls } = await openInbox(buildDetailAnswer(none, { offers: [] }), [none]);
    await screen.findByText("Reprice the loyalty tiers");
    await openSheetOf(user, "Reprice the loyalty tiers");

    await user.keyboard("h");

    expect(await screen.findByText(/No workflow takes a ticket/)).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(none))).toHaveLength(0);
  });

  it("hands a linked thing the Inbox does not list, from the sheet that walked to it", async () => {
    const user = userEvent.setup();
    const peer = ticket(7, "Reconcile the depot counts");
    const { calls } = await openInbox(
      {
        ...buildDetailAnswer(REFUNDS, {
          links: [
            {
              fromRef: REFUNDS.ref,
              toRef: peer.ref,
              hasPersonClaim: true,
              claim: { type: "person" },
            },
          ],
          peers: [
            {
              id: peer.id,
              ref: peer.ref,
              kind: peer.kind,
              noun: peer.noun,
              identifier: peer.identifier,
              title: peer.title,
              yours: false,
              restricted: false,
            },
          ],
        }),
        ...buildDetailAnswer(peer),
        [handOffPath(peer)]: { body: HANDED },
      },
      [REFUNDS],
    );
    await screen.findByText("Refund a returned order");
    const sheet = await openSheetOf(user, "Refund a returned order");

    await user.click(
      await within(sheet).findByRole("button", { name: /^(?!Remove).*Reconcile the depot counts/ }),
    );
    // The Inbox does not list the peer, so the sheet is named from the peer's own read.
    const peerSheet = await screen.findByRole("dialog", { name: "Reconcile the depot counts" });
    await waitFor(() => {
      expect(peerSheet.querySelector("[data-arming]")).toBeNull();
    });
    await user.click(await within(peerSheet).findByRole("button", { name: /^Agent review/ }));

    expect(
      await screen.findByText("Handed Ticket OPS-7 to Agent review. Its Task is on Work."),
    ).toBeTruthy();
    expect(listCallsTo(calls, handOffPath(peer))).toHaveLength(1);
    expect(listCallsTo(calls, handOffPath(REFUNDS))).toHaveLength(0);
  });
});

describe("Undo of a hand-off", () => {
  const handAndUndo = async (outcome: HandOffUndo["outcome"]) => {
    const user = userEvent.setup();
    const { calls, router } = await openInbox({
      [handOffPath(REFUNDS)]: { body: HANDED },
      [undoPath]: { body: UNDO_OF[outcome] },
    });
    await handRefunds(user);
    await user.click(screen.getByRole("button", { name: /^Undo/ }));
    return { calls, router, user };
  };

  it("takes the card back when nothing had started: no colleague, no Task, and what stays ended is said", async () => {
    const { calls } = await handAndUndo("undone");

    expect(
      await screen.findByText(
        "Took back Agent review. Nothing had started. Review requested stays ended.",
      ),
    ).toBeTruthy();
    expect(listCallsTo(calls, undoPath)).toHaveLength(1);
    const card = getCard("Refund a returned order");
    await waitFor(() => {
      expect(within(card).queryByRole("img", { name: "Agent review has it" })).toBeNull();
    });
    expect(card.hasAttribute("data-has-task")).toBe(false);
  });

  it("keeps the card with its colleague and Task when the run was only asked to stop, and says so", async () => {
    const { router, user } = await handAndUndo("stopped");

    expect(
      await screen.findByText(
        "Asked Agent review to stop. Anything it already did stays. The run had already started a step. Review requested stays ended.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Could not|Put back/)).toBeNull();
    const card = getCard("Refund a returned order");
    expect(within(card).getByRole("img", { name: "Agent review has it" })).toBeTruthy();
    expect(card.hasAttribute("data-has-task")).toBe(true);

    await user.click(screen.getByRole("button", { name: "See its Task" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/work");
    });
    expect(router.state.location.search).toMatchObject({ task: TASK_ID });
  });

  it("changes nothing and says the run finished when it is too late", async () => {
    await handAndUndo("too-late");

    expect(
      await screen.findByText("Agent review already finished. Review requested stays ended."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See its Task" })).toBeNull();
    const card = getCard("Refund a returned order");
    expect(within(card).getByRole("img", { name: "Agent review has it" })).toBeTruthy();
    expect(card.hasAttribute("data-has-task")).toBe(true);
  });
});

describe("Undo of a hand-off from another screen", () => {
  it("takes the hand-off back with the Undo key and says so in the toast, and the card is as it was when the Inbox opens", async () => {
    const user = userEvent.setup();
    const { calls, router } = await openInbox({
      [handOffPath(REFUNDS)]: { body: HANDED },
      [undoPath]: { body: UNDO_OF.undone },
    });
    await handRefunds(user);

    await router.navigate({ to: "/settings" });
    await waitFor(() => {
      expect(document.querySelector(".inbox-scroll")).toBeNull();
    });
    await user.keyboard("{Meta>}z{/Meta}");

    await waitFor(() => {
      expect(listCallsTo(calls, undoPath)).toHaveLength(1);
    });
    expect(await screen.findByText(/^Took back Agent review\. Nothing had started\./)).toBeTruthy();

    await router.navigate({ to: "/inbox" });
    const card = await screen.findByRole("listitem", { name: /Refund a returned order/ });
    expect(card.hasAttribute("data-has-task")).toBe(false);
  });
});

describe("carrying a card", () => {
  /** Where the cards lie in the carry tests: jsdom has no layout, so each card gets a band of its own. */
  const BANDS: Readonly<Record<string, number>> = {
    [REFUNDS.id]: 0,
    [SLOTS.id]: 100,
    [BASKET.id]: 200,
    [REVIEW.id]: 300,
  };
  const bandOf = (y: number): string | undefined =>
    Object.keys(BANDS).find((id) => y >= BANDS[id]! && y < BANDS[id]! + 100);

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = BANDS[this.dataset["cardId"] ?? ""];
      return new DOMRect(0, top ?? 0, top === undefined ? 0 : 400, top === undefined ? 0 : 100);
    });
    document.elementFromPoint = (_x: number, y: number): Element | null => {
      const id = bandOf(y);
      return id === undefined ? document.body : document.querySelector(`[data-card-id="${id}"]`);
    };
    const held = new Set<number>();
    Element.prototype.setPointerCapture = (id: number) => void held.add(id);
    Element.prototype.releasePointerCapture = (id: number) => void held.delete(id);
    Element.prototype.hasPointerCapture = (id: number) => held.has(id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Lifts the card `from` by pressing on its title and moving the pointer 10px. Returns where the pointer is. */
  const lift = (from: InboxCard) => {
    const title = document.querySelector(`[data-card-id="${from.id}"] .row-title`)!;
    const y = BANDS[from.id]! + 50;
    fireEvent.pointerDown(title, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 50,
      clientY: y,
    });
    fireEvent.pointerMove(window, { pointerId: 1, isPrimary: true, clientX: 50, clientY: y + 10 });
    return document.querySelector<HTMLElement>(".inbox-scroll")!;
  };
  const drop = (y: number): void => {
    fireEvent.pointerMove(window, { pointerId: 1, isPrimary: true, clientX: 50, clientY: y });
    fireEvent.pointerUp(window, { pointerId: 1, isPrimary: true, clientX: 50, clientY: y });
  };

  it("links the card to the one it is let go over, with one Undo that unlinks them", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({
      [LINK_PATH]: { body: {} },
      [UNLINK_PATH]: { body: { removed: true } },
    });
    await screen.findByText("Refund a returned order");

    lift(REFUNDS);
    // The rail rises with the workflows that can take the card, then Take it and Dismiss.
    expect(document.querySelector(".inbox-rail")?.textContent).toContain("Agent review");
    drop(BANDS[BASKET.id]! + 50);

    await waitFor(() => {
      expect(listCallsTo(calls, LINK_PATH)).toHaveLength(1);
    });
    expect(listCallsTo(calls, LINK_PATH)[0]?.body).toEqual({
      fromRef: REFUNDS.ref,
      toRef: BASKET.ref,
    });
    expect(await screen.findByText("Linked OPS-1 and OPS-3.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    await waitFor(() => {
      expect(listCallsTo(calls, UNLINK_PATH)).toHaveLength(1);
    });
    expect(listCallsTo(calls, UNLINK_PATH)[0]?.body).toEqual({
      fromRef: REFUNDS.ref,
      toRef: BASKET.ref,
    });
  });

  it("sends the card home on Esc and lets the page do nothing with the key", async () => {
    const user = userEvent.setup();
    const { calls } = await openInbox({});
    await screen.findByText("Refund a returned order");
    await user.hover(getCard("Refund a returned order"));
    const card = getCard("Refund a returned order");
    expect(card.getAttribute("data-current")).toBe("pointer");

    lift(REFUNDS);
    expect(document.querySelector(".inbox-rail")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });

    // The page's Esc would have taken the card's current mark away.
    expect(card.getAttribute("data-current")).toBe("pointer");
    expect(card.hasAttribute("data-carried")).toBe(false);
    expect(listCallsTo(calls, LINK_PATH)).toHaveLength(0);
  });
});
