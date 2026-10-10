/**
 * Tests Intake: the list of signals on To do in its sections, the pane of the
 * selected signal, Intake's keys, answering a signal, a signal resolved
 * elsewhere while its pane is open, the split's handle, and the To do count
 * on the sidebar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Event, PluginDetail, Signal, SignalAction } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Call,
  type Handler,
} from "../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// Every element measures as wide as a window that fits the list and the pane,
// and the virtualized list draws the rows that fit its height.
beforeEach(() => {
  stubElementSize(1168, 800);
  // jsdom lays nothing out, so it has no `scrollIntoView`.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  localStorage.clear();
});

const GITHUB: PluginDetail = {
  id: "github",
  displayName: "GitHub",
  hostApi: 1,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
};

const CONNECTION_ID = "01a06d02-7200-7000-8000-0000000000c1";

/** The event a GitHub signal was raised from, which gives the pane its "Open on GitHub" link. */
const buildEvent = (id: number, url: string): Event => ({
  id,
  source: "github",
  connectionId: CONNECTION_ID,
  system: "github",
  kind: "github.notification",
  occurredAt: "2026-10-10T09:18:00.000Z",
  receivedAt: "2026-10-10T09:18:01.000Z",
  dedupKey: `github-${String(id)}`,
  refs: [],
  url,
  payload: {},
  raw: null,
  actor: null,
});

const buildAction = (id: string, over: Partial<SignalAction> = {}): SignalAction => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  operation: { op: "github/pr.review", input: {} },
  describeLine: [{ kind: "text", text: `Does ${id}` }],
  ...over,
});

const DONE = buildAction("done", {
  operation: null,
  describeLine: [{ kind: "text", text: "Marks it done" }],
});

/** Builds an open GitHub signal raised from event `eventId`, created at `time` today. */
const buildSignal = (
  id: string,
  eventId: number,
  time: string,
  over: Partial<Signal> = {},
): Signal => ({
  id,
  kind: "github/review-requested",
  origin: {
    type: "event",
    eventId,
    connectionId: CONNECTION_ID,
    threadRef: `acme/webshop#${String(eventId)}`,
  },
  title: `Signal ${id.slice(-2)}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: `2026-10-10T${time}:00.000Z`,
  ...over,
});

/** A review request whose suggested answer is Approve, with a block this app does not know. */
const REVIEW = buildSignal("01a06d02-7a00-7000-8000-000000000001", 1, "09:18", {
  title: "Retry Stripe webhooks with backoff",
  asker: "Marta",
  place: "acme/payments-api#1294",
  blocks: [
    {
      type: "change",
      from: "marta/webhook-backoff",
      to: "main",
      files: 6,
      additions: 142,
      deletions: 38,
    },
    { type: "poll" },
  ],
  actions: [
    buildAction("approve", {
      primary: true,
      describeLine: [
        { kind: "text", text: "Approves pull request " },
        { kind: "marked", text: "#1294" },
      ],
    }),
    DONE,
  ],
});

/** A mention whose suggested answer is a typed reply. */
const MENTION = buildSignal("01a06d02-7a00-7000-8000-000000000002", 2, "10:41", {
  kind: "github/mentioned",
  title: "Refunds for partial captures",
  asker: "Jonas",
  place: "acme/webshop#1301",
  actions: [
    buildAction("reply", {
      label: "Reply…",
      primary: true,
      operation: { op: "github/comment.create", input: {} },
      field: { name: "body", placeholder: "Reply to Jonas…" },
    }),
    DONE,
  ],
});

/** An urgent signal, which the list puts under Now. */
const ALERT = buildSignal("01a06d02-7a00-7000-8000-000000000003", 3, "11:02", {
  kind: "github/checks-failed",
  title: "Checks failed on main",
  priority: "urgent",
});

const SIGNALS = [REVIEW, MENTION, ALERT];

/** Returns the signal as resolved by `actor`, with the one line its outcome reads. */
const resolve = (signal: Signal, actor: string, outcome: string): Signal => ({
  ...signal,
  status: "resolved",
  resolution: {
    kind: "decided",
    actionId: "approve",
    outcome,
    actor,
    origin: actor === "user" ? "web" : "plugin:github",
    at: "2026-10-10T11:30:00.000Z",
  },
});

/**
 * Returns handlers that play the controller's signals on one stored list:
 * To do lists the open ones, and each read answers with the stored record.
 * `store` changes a stored signal, as an answer on the source would.
 */
const storeSignals = (initial: ReadonlyArray<Signal>) => {
  let stored = [...initial];
  const handlers: Record<string, Handler> = {
    "GET /api/v1/signals": () => ({ body: stored.filter((signal) => signal.status === "open") }),
    "GET /api/v1/plugins": { body: [GITHUB] },
  };
  for (const signal of initial) {
    handlers[`GET /api/v1/signals/${signal.id}`] = () => ({
      body: stored.find((each) => each.id === signal.id),
    });
    if (signal.origin.type === "event") {
      const eventId = signal.origin.eventId;
      handlers[`GET /api/v1/events/${String(eventId)}`] = {
        body: buildEvent(eventId, `https://github.com/acme/webshop/pull/${String(eventId)}`),
      };
    }
  }
  const store = (changed: Signal): void => {
    stored = stored.map((signal) => (signal.id === changed.id ? changed : signal));
  };
  return { handlers, store };
};

/** Opens the app at `path` with the signals in `handlers` on top of the sidebar's records. */
const openIntake = async (
  path = "/intake",
  handlers: Readonly<Record<string, Handler>> = storeSignals(SIGNALS).handlers,
) => {
  const calls = stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path,
    },
  );
  await screen.findByRole("heading", { level: 1, name: "Intake" });
  return { calls, ...app };
};

const getList = () => screen.getByRole("region", { name: "Signals" });
const getRow = (signal: Signal) =>
  getList().querySelector<HTMLElement>(`[data-signal-id="${signal.id}"]`)!;
const findPane = () => screen.findByRole("region", { name: "The open signal" });

/**
 * Checks whether the pane shows. A closed pane stays drawn while a signal is
 * selected, off screen and inert, so it slides out, and the query alone does
 * not tell the two apart.
 */
const isPaneShown = (): boolean => {
  const pane = screen.queryByRole("region", { name: "The open signal" });
  return pane !== null && !pane.hasAttribute("inert");
};
const readSelected = (search: Record<string, unknown>) => search.signal;
/** Checks whether a request answers a signal; the app's other requests include POSTs of its own. */
const isAct = (call: Call) => call.method === "POST" && call.path.endsWith("/act");

describe("Intake's list", () => {
  it("draws Now above Signals, each oldest first, and counts each tab", async () => {
    await openIntake();
    const list = getList();
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Now", "Signals2"]);
    expect([...list.querySelectorAll(".ask-title")].map((title) => title.textContent)).toEqual([
      "Checks failed on main",
      REVIEW.title,
      MENTION.title,
    ]);
    expect(getRow(REVIEW).textContent).toContain(
      "Marta · review requested · acme/payments-api#1294",
    );
    const tabs = screen.getByRole("navigation", { name: "Sources" });
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((tab) => tab.textContent),
    ).toEqual(["All3", "GitHub3"]);
  });

  it("says the list is empty when nothing is on To do", async () => {
    await openIntake("/intake", storeSignals([]).handlers);
    expect(screen.getByText("Nothing on your list.")).toBeTruthy();
  });

  it("puts Intake's To do count on its sidebar row and on the Hercule segment", async () => {
    await openIntake();
    const segment = screen.getByRole("tab", { name: "Hercule, 3 to do" });
    expect(segment.getAttribute("aria-selected")).toBe("true");
    const row = screen.getByRole("link", { name: /^Intake/ });
    expect(row.textContent).toBe("Intake3");
    expect(row.getAttribute("aria-current")).toBe("page");
  });
});

describe("Intake's pane", () => {
  it("opens on a clicked row, with the asker, the blocks, the answers and the source's link", async () => {
    const { router } = await openIntake();
    await userEvent.click(getRow(REVIEW));
    expect(readSelected(router.state.location.search)).toBe(REVIEW.id);
    const pane = await findPane();
    expect(within(pane).getByRole("heading", { level: 2 }).textContent).toBe(REVIEW.title);
    expect(pane.querySelector(".ad-asked")!.textContent).toMatch(
      /^Marta asks in acme\/payments-api#1294 · /,
    );
    expect(within(pane).getByText("This part can't be shown here.")).toBeTruthy();
    const approve = within(pane).getByRole("button", { name: "Approve" });
    expect(approve.querySelector(".btn--accent")).not.toBeNull();
    expect(within(pane).getByText("#1294").tagName).toBe("B");
    const link = await within(pane).findByRole("link", { name: "Open on GitHub" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/webshop/pull/1");
    expect(getRow(REVIEW).getAttribute("aria-current")).toBe("true");
  });

  it("draws Done as an answer that is not built yet, and sends nothing for it", async () => {
    const { calls } = await openIntake(`/intake?signal=${REVIEW.id}`);
    const pane = await findPane();
    const done = within(pane).getByRole("button", { name: "Done" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    expect(done.getAttribute("title")).toBe("Not built yet");
    await userEvent.click(done);
    expect(calls.some(isAct)).toBe(false);
  });

  it("shows what the user did once an answer succeeds", async () => {
    const { handlers, store } = storeSignals(SIGNALS);
    const { calls, live } = await openIntake(`/intake?signal=${REVIEW.id}`, {
      ...handlers,
      [`POST /api/v1/signals/${REVIEW.id}/act`]: () => {
        const acted = resolve(REVIEW, "user", "Approved #1294");
        store(acted);
        return { body: acted };
      },
    });
    const pane = await findPane();
    await userEvent.click(within(pane).getByRole("button", { name: "Approve" }));
    const outcome = await within(pane).findByRole("status");
    expect(outcome.textContent).toBe("What you did: Approved #1294, by you");
    expect(calls.find(isAct)?.body).toEqual({ actionId: "approve" });
    // The answer's audit entry reaches the app as a push on the `signal`
    // topic, and the list reads To do again, which no longer holds the signal.
    live.pushInvalidation("signal", [REVIEW.id]);
    await waitFor(() => {
      expect(getList().querySelector(`[data-signal-id="${REVIEW.id}"]`)).toBeNull();
    });
  });

  it("shows why a reply failed under its box, and keeps the text", async () => {
    const { calls } = await openIntake(`/intake?signal=${MENTION.id}`, {
      ...storeSignals(SIGNALS).handlers,
      [`POST /api/v1/signals/${MENTION.id}/act`]: {
        status: 409,
        body: buildErrorBody("invalid_state", "The pull request is locked."),
      },
    });
    const pane = await findPane();
    // A suggested reply opens with its box.
    const box = within(pane).getByRole("textbox", { name: "Reply" });
    await userEvent.type(box, "Through the ledger first.");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    const alert = await within(pane).findByRole("alert");
    expect(alert.textContent).toBe("The pull request is locked.");
    expect((box as HTMLTextAreaElement).value).toBe("Through the ledger first.");
    expect(calls.find(isAct)?.body).toEqual({
      actionId: "reply",
      text: "Through the ledger first.",
    });
  });

  it("does not send an empty reply", async () => {
    const { calls } = await openIntake(`/intake?signal=${MENTION.id}`);
    const pane = await findPane();
    const send = within(pane).getByRole("button", { name: /^Reply/ });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(send);
    expect(calls.some(isAct)).toBe(false);
  });

  it("says when the signal was resolved elsewhere while it was open, and keeps the reply typed", async () => {
    const { handlers, store } = storeSignals(SIGNALS);
    const { live } = await openIntake(`/intake?signal=${MENTION.id}`, handlers);
    const pane = await findPane();
    await userEvent.type(within(pane).getByRole("textbox", { name: "Reply" }), "Ledger first.");

    store(resolve(MENTION, "plugin:github", "Replied on GitHub"));
    live.pushInvalidation("signal", [MENTION.id]);

    const outcome = await within(pane).findByRole("status");
    expect(outcome.textContent).toBe("Resolved elsewhere: replied on GitHub, by GitHub");
    const kept = within(pane).getByRole("textbox", { name: "Your reply, not sent" });
    expect((kept as HTMLTextAreaElement).value).toBe("Ledger first.");
  });
});

describe("Intake's keys", () => {
  it("move the selection with J and K, and keep the focus on the rows", async () => {
    const { router } = await openIntake();
    await userEvent.click(getRow(ALERT));
    await userEvent.keyboard("j");
    expect(readSelected(router.state.location.search)).toBe(REVIEW.id);
    await waitFor(() => {
      expect(document.activeElement).toBe(getRow(REVIEW));
    });
    await userEvent.keyboard("{ArrowDown}");
    expect(readSelected(router.state.location.search)).toBe(MENTION.id);
    await userEvent.keyboard("j");
    expect(readSelected(router.state.location.search)).toBe(MENTION.id);
    await userEvent.keyboard("k");
    expect(readSelected(router.state.location.search)).toBe(REVIEW.id);
  });

  it("put the focus on the suggested answer when ↩ opens a row", async () => {
    await openIntake();
    getRow(REVIEW).focus();
    await userEvent.keyboard("{Enter}");
    const pane = await findPane();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(pane).getByRole("button", { name: "Approve" }));
    });
  });

  it("put the focus in a suggested reply's box when ↩ opens its row", async () => {
    await openIntake();
    getRow(MENTION).focus();
    await userEvent.keyboard("{Enter}");
    const pane = await findPane();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(pane).getByRole("textbox", { name: "Reply" }));
    });
  });

  it("close the pane with Esc, keeping the row selected, and clear the selection with a second Esc", async () => {
    const { router } = await openIntake();
    getRow(REVIEW).focus();
    await userEvent.keyboard("{Enter}");
    const pane = await findPane();
    await waitFor(() => {
      expect(pane.contains(document.activeElement)).toBe(true);
    });

    await userEvent.keyboard("{Escape}");
    expect(isPaneShown()).toBe(false);
    expect(readSelected(router.state.location.search)).toBe(REVIEW.id);
    expect(document.activeElement).toBe(getRow(REVIEW));

    await userEvent.keyboard("{Escape}");
    expect(readSelected(router.state.location.search)).toBeUndefined();
    expect(getRow(REVIEW).getAttribute("aria-current")).toBeNull();
  });

  it("open the Reply box with R", async () => {
    await openIntake(`/intake?signal=${MENTION.id}`);
    const pane = await findPane();
    const box = within(pane).getByRole("textbox", { name: "Reply" });
    getRow(MENTION).focus();
    await userEvent.keyboard("r");
    expect(document.activeElement).toBe(box);
  });

  it("are not taken in a text box", async () => {
    const { router } = await openIntake(`/intake?signal=${MENTION.id}`);
    const pane = await findPane();
    const box = within(pane).getByRole("textbox", { name: "Reply" });
    await userEvent.type(box, "jk");
    expect((box as HTMLTextAreaElement).value).toBe("jk");
    expect(readSelected(router.state.location.search)).toBe(MENTION.id);
  });
});

describe("Intake's split", () => {
  it("widens and narrows the list with the arrow keys on its handle, and keeps the width", async () => {
    await openIntake(`/intake?signal=${REVIEW.id}`);
    await findPane();
    // jsdom lays nothing out, so the list measures as wide as it was drawn.
    vi.spyOn(getList(), "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 272, y: 0, width: 432, height: 800 }),
    );
    const handle = screen.getByRole("separator", { name: "Resize the list" });
    // The split is 1168px wide and the pane keeps at least 400px of it.
    expect(handle.getAttribute("aria-valuemax")).toBe("768");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("448");
    expect(localStorage.getItem("hercule.intake.list-width")).toBe("448");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(localStorage.getItem("hercule.intake.list-width")).toBe("416");
  });

  it("keeps the pane closed while the window is too narrow for it, and says why", async () => {
    stubElementSize(700, 800);
    await openIntake(`/intake?signal=${REVIEW.id}`);
    expect(isPaneShown()).toBe(false);
    const toggle = screen.getByRole("button", { name: "Signal pane" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("Widen the window to show the pane");
  });

  it("hides and shows the pane with the bar's button", async () => {
    await openIntake(`/intake?signal=${REVIEW.id}`);
    await findPane();
    const toggle = screen.getByRole("button", { name: "Signal pane" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.title).toBe("Hide the signal  Esc");
    await userEvent.click(toggle);
    expect(isPaneShown()).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("Show the signal");
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(isPaneShown()).toBe(true);
    });
  });
});
