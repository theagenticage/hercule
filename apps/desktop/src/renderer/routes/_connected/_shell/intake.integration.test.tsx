/**
 * Tests Intake: the list of signals on To do in its sections, the pane of the
 * selected signal, Intake's keys, answering a signal, a signal resolved
 * elsewhere while its pane is open, the split's handle, the To do count on
 * the sidebar, and the Everything view of the events behind the signals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Connection,
  Event,
  EventWithFacts,
  PluginDetail,
  Signal,
  SignalAction,
} from "@hercule/contract";
import {
  answerSignalQuery,
  buildErrorBody,
  buildFixtureAssistant,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_GITHUB_CONNECTION,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  stubResizeObserver,
  type Answer,
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
  vi.useRealTimers();
});

/** A stand-in for the mark the GitHub plugin returns with its record: one path on the 16 by 16 grid. */
const GITHUB_MARK_PATH = "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0z";

const GITHUB: PluginDetail = {
  id: "github",
  displayName: "GitHub",
  mark: { paths: [GITHUB_MARK_PATH] },
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
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
  title: `Pull request #${String(id)}`,
  author: "Marta",
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

/**
 * Returns the signal as resolved by `actor` at `at`, with the one line its
 * outcome reads.
 */
const resolve = (
  signal: Signal,
  actor: string,
  outcome: string,
  at = "2026-10-10T11:30:00.000Z",
): Signal => ({
  ...signal,
  status: "resolved",
  resolution: {
    kind: "decided",
    actionId: "approve",
    outcome,
    actor,
    origin: actor === "user" ? "web" : "core",
    at,
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
    "GET /api/v1/signals": (call) => answerSignalQuery(stored, call),
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
  /** Changes each stored signal the call names with `change`, and returns their ids. */
  const moveSignals = (call: Call, change: (signal: Signal) => Signal): ReadonlyArray<string> => {
    const { signalIds } = call.body as { signalIds: ReadonlyArray<string> };
    stored = stored.map((signal) => (signalIds.includes(signal.id) ? change(signal) : signal));
    return signalIds;
  };
  handlers["POST /api/v1/signals/mark-done"] = (call) => ({
    body: {
      done: moveSignals(call, (signal) => resolve(signal, "user", "Marked done")),
      skipped: [],
    },
  });
  handlers["POST /api/v1/signals/snooze"] = (call) => {
    const { until } = call.body as { until: string };
    const snoozedAt = new Date().toISOString();
    return {
      body: {
        snoozed: moveSignals(call, (signal) => ({ ...signal, snooze: { until, snoozedAt } })),
        skipped: [],
      },
    };
  };
  handlers["POST /api/v1/signals/unsnooze"] = (call) => ({
    body: {
      unsnoozed: moveSignals(call, (signal) => {
        const unsnoozed: { -readonly [Key in keyof Signal]: Signal[Key] } = { ...signal };
        delete unsnoozed.snooze;
        return unsnoozed;
      }),
      skipped: [],
    },
  });
  handlers["POST /api/v1/signals/lower-priority"] = (call) => ({
    body: {
      lowered: moveSignals(call, (signal) => ({ ...signal, priority: "high" })),
      skipped: [],
    },
  });
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
/** Waits for the toast of the last move, which is not the bulk bar. */
const findToast = () =>
  waitFor(() => {
    const toast = document.querySelector<HTMLElement>(".asks-toast:not(.asks-bulk)");
    expect(toast).not.toBeNull();
    return toast!;
  });
/** Returns the item that holds `signal`'s row, its checkbox and its moves. */
const getItem = (signal: Signal) => getRow(signal).closest<HTMLElement>(".ask-item")!;
/**
 * Clicks the move `name` on `signal`'s row. The moves show only while the
 * pointer is on the row, and jsdom matches no `:hover`, so the click skips
 * the check that the moves take the pointer.
 */
const clickRowMove = (signal: Signal, name: string) =>
  userEvent.click(within(getItem(signal)).getByRole("button", { name }), {
    pointerEventsCheck: 0,
  });
/** Returns the request of the move `path`, such as `mark-done`, or `undefined` when none was sent. */
const findMove = (calls: ReadonlyArray<Call>, path: string) =>
  calls.find((call) => call.method === "POST" && call.path === `/api/v1/signals/${path}`);

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

  it("draws GitHub's mark from its plugin record on its tab, its rows and the pane's provenance line", async () => {
    await openIntake(`/intake?signal=${REVIEW.id}`);
    const tabs = screen.getByRole("navigation", { name: "Sources" });
    const pane = await findPane();
    const marks = [
      within(tabs)
        .getByRole("button", { name: /GitHub/ })
        .querySelector("svg"),
      getRow(REVIEW).querySelector(".ask-mark svg"),
      pane.querySelector(".ad-kind .src svg"),
    ];
    expect(marks.map((mark) => mark?.querySelector("path")?.getAttribute("d"))).toEqual([
      GITHUB_MARK_PATH,
      GITHUB_MARK_PATH,
      GITHUB_MARK_PATH,
    ]);
    expect(marks.map((mark) => mark?.getAttribute("width"))).toEqual(["14", "16", "14"]);
    expect(pane.querySelector(".ad-kind .src")!.textContent).toBe("GitHub · Review requested");
  });

  it("links a plugin signal's provenance line to its kind on Settings > Intake, on the Connection it came from", async () => {
    await openIntake(`/intake?signal=${REVIEW.id}`);
    const pane = await findPane();

    const link = pane.querySelector(".ad-kind a.src")!;
    const href = new URL(link.getAttribute("href")!, "http://app.test");
    expect(href.pathname).toBe("/settings/intake");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      kind: "github/review-requested",
      connection: CONNECTION_ID,
    });
  });

  it("links a plugin signal raised through the API to its kind only", async () => {
    const byApi = buildSignal("01a06d02-7a00-7000-8000-000000000013", 0, "12:00", {
      title: "Raised through the API",
      origin: { type: "api", actor: "user", eventIds: [], reason: "Seen twice" },
    });
    await openIntake(`/intake?signal=${byApi.id}`, storeSignals([byApi]).handlers);
    const pane = await findPane();

    const href = new URL(
      pane.querySelector(".ad-kind a.src")!.getAttribute("href")!,
      "http://app.test",
    );
    expect(Object.fromEntries(href.searchParams)).toEqual({ kind: "github/review-requested" });
  });

  it("draws the provenance line of a core signal as plain text", async () => {
    const core = buildSignal("01a06d02-7a00-7000-8000-000000000014", 0, "12:01", {
      kind: "proposal",
      title: "A proposal",
      origin: { type: "api", actor: "user", eventIds: [], reason: "Seen twice" },
    });
    await openIntake(`/intake?signal=${core.id}`, storeSignals([core]).handlers);
    const pane = await findPane();

    expect(pane.querySelector(".ad-kind a")).toBeNull();
    expect(pane.querySelector(".ad-kind span.src")!.textContent).toBe("You · Proposal");
  });

  it("names the workflow or the assistant that raised a core signal", async () => {
    const triage = { id: "01a06d02-7b00-7000-8000-000000000001", name: "Triage" };
    const ada = buildFixtureAssistant({
      id: "01a06d02-7700-7000-8000-000000000001",
      name: "Ada",
      mainConversationId: "01a06d02-7800-7000-8000-000000000001",
    });
    const raisedBy = (id: string, actor: string, ids: Record<string, string>): Signal =>
      buildSignal(id, 0, "12:00", {
        kind: "proposal",
        title: `Proposal ${id.slice(-2)}`,
        origin: { type: "api", actor, eventIds: [], reason: "Seen twice this week", ...ids },
      });
    const byWorkflow = raisedBy(
      "01a06d02-7a00-7000-8000-000000000011",
      "run:01a06d02-7c00-7000-8000-000000000001",
      { runId: "01a06d02-7c00-7000-8000-000000000001", workflowId: triage.id },
    );
    const byAssistant = raisedBy(
      "01a06d02-7a00-7000-8000-000000000012",
      "session:01a06d02-7d00-7000-8000-000000000001",
      { assistantId: ada.id },
    );
    await openIntake(`/intake?signal=${byWorkflow.id}`, {
      ...buildSidebarHandlers({
        ...SIDEBAR_FIXTURE,
        assistants: [{ assistant: ada, session: null }],
      }),
      ...storeSignals([byWorkflow, byAssistant]).handlers,
      "GET /api/v1/workflows": {
        body: { items: [{ ...triage, enabled: true, updatedAt: "2026-10-01T09:00:00.000Z" }] },
      },
    });
    expect(getRow(byWorkflow).querySelector(".ask-sub")!.textContent).toBe("Triage · proposal");
    expect(getRow(byAssistant).querySelector(".ask-sub")!.textContent).toBe("Ada · proposal");
    const pane = await findPane();
    expect(pane.querySelector(".ad-kind .src")!.textContent).toBe("Triage · Proposal");
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

  it("marks the signal done with Done, and opens the next one", async () => {
    const { calls, router } = await openIntake(`/intake?signal=${REVIEW.id}`);
    const pane = await findPane();
    await userEvent.click(within(pane).getByRole("button", { name: "Done" }));
    expect(findMove(calls, "mark-done")?.body).toEqual({ signalIds: [REVIEW.id] });
    expect(calls.some(isAct)).toBe(false);
    expect((await findToast()).textContent).toBe(`Done · ${REVIEW.title}`);
    await waitFor(() => {
      expect(readSelected(router.state.location.search)).toBe(MENTION.id);
    });
    expect(getList().querySelector(`[data-signal-id="${REVIEW.id}"]`)).toBeNull();
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
    expect(outcome.querySelector(".b-work-label")!.textContent).toBe("What you did");
    expect(outcome.querySelector("b")!.textContent).toBe("Approved #1294");
    expect(outcome.querySelector(".b-work-text > span:last-child")!.textContent).toMatch(
      /^Here · .+ · by you$/,
    );
    expect(outcome.querySelector(".ad-mark .mark--done")).not.toBeNull();
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

  it("says when no workflow screened the signal, under its blocks", async () => {
    const unscreened = buildSignal("01a06d02-7a00-7000-8000-000000000009", 9, "09:30", {
      title: "Mail from Marta",
      origin: {
        type: "event",
        eventId: 9,
        connectionId: CONNECTION_ID,
        threadRef: "acme/webshop#9",
        notScreened: { reason: "no-screener" },
      },
      blocks: [{ type: "text", markdown: "Can you sign the lease?" }],
    });
    await openIntake(`/intake?signal=${unscreened.id}`, storeSignals([unscreened]).handlers);
    const pane = await findPane();
    const line = within(pane).getByText("Not screened: no workflow screens signals");
    const blocks = pane.querySelector(".ad-blocks")!;
    expect(blocks.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says when the signal was resolved elsewhere while it was open, and keeps the reply typed", async () => {
    const { handlers, store } = storeSignals(SIGNALS);
    const { live } = await openIntake(`/intake?signal=${MENTION.id}`, handlers);
    const pane = await findPane();
    await userEvent.type(within(pane).getByRole("textbox", { name: "Reply" }), "Ledger first.");

    store(resolve(MENTION, "system", "Replied on GitHub"));
    live.pushInvalidation("signal", [MENTION.id]);

    const outcome = await within(pane).findByRole("status");
    expect(outcome.querySelector(".b-work-label")!.textContent).toBe("What you did");
    expect(outcome.querySelector(".ad-outcome-desc")!.textContent).toBe(
      "Resolved elsewhere: Replied on GitHub, by you",
    );
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

  it("draw the closed pane only while it slides out, and no pane for a signal J moves to", async () => {
    const { router } = await openIntake(`/intake?signal=${REVIEW.id}`);
    await findPane();
    getRow(REVIEW).focus();
    await userEvent.keyboard("{Escape}");
    // The pane slides out, still drawn, until the list's width transition ends.
    expect(screen.getByRole("region", { name: "The open signal" }).hasAttribute("inert")).toBe(
      true,
    );
    fireEvent.transitionEnd(getList(), { propertyName: "width" });
    expect(screen.queryByRole("region", { name: "The open signal" })).toBeNull();

    // With the pane closed, J moves the selection and reads no signal.
    await userEvent.keyboard("j");
    expect(readSelected(router.state.location.search)).not.toBe(REVIEW.id);
    expect(screen.queryByRole("region", { name: "The open signal" })).toBeNull();
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

  it("keep working after an answer given from the keyboard resolves the signal", async () => {
    const { handlers, store } = storeSignals(SIGNALS);
    const { router } = await openIntake("/intake", {
      ...handlers,
      [`POST /api/v1/signals/${REVIEW.id}/act`]: () => {
        const acted = resolve(REVIEW, "user", "Approved #1294");
        store(acted);
        return { body: acted };
      },
    });
    getRow(REVIEW).focus();
    await userEvent.keyboard("{Enter}");
    const pane = await findPane();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(pane).getByRole("button", { name: "Approve" }));
    });
    await userEvent.keyboard("{Enter}");
    await within(pane).findByRole("status");
    // The answers are gone, and the focus stays in the pane, where the keys act.
    expect(pane.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("j");
    expect(readSelected(router.state.location.search)).toBe(MENTION.id);
  });

  it("keep working after the signal whose reply is being typed is resolved elsewhere", async () => {
    const { handlers, store } = storeSignals(SIGNALS);
    const { live, router } = await openIntake(`/intake?signal=${MENTION.id}`, handlers);
    const pane = await findPane();
    await userEvent.type(within(pane).getByRole("textbox", { name: "Reply" }), "Ledger first.");

    store(resolve(MENTION, "system", "Replied on GitHub"));
    live.pushInvalidation("signal", [MENTION.id]);
    await within(pane).findByRole("status");

    // The focus leaves the Reply box for the pane, not for the kept reply, which is a text box.
    expect(pane.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(
      within(pane).getByRole("textbox", { name: "Your reply, not sent" }),
    );
    await userEvent.keyboard("{Escape}");
    expect(isPaneShown()).toBe(false);
    // The signal has left To do, so it has no row to take the focus back,
    // and the list takes it: the closing pane is inert and would drop it.
    expect(document.activeElement).toBe(getList());
    await userEvent.keyboard("{Escape}");
    expect(readSelected(router.state.location.search)).toBeUndefined();
  });
  it("keep working when the window grows too narrow for the pane while the focus is in it", async () => {
    const resize = stubResizeObserver();
    const { router } = await openIntake(`/intake?signal=${MENTION.id}`);
    const pane = await findPane();
    within(pane).getByRole("textbox", { name: "Reply" }).focus();

    stubElementSize(700, 800);
    act(() => {
      resize(getList().parentElement!);
    });
    expect(isPaneShown()).toBe(false);
    // The closing pane is inert and would drop the focus, so the selected row takes it.
    expect(document.activeElement).toBe(getRow(MENTION));
    await userEvent.keyboard("{Escape}");
    expect(readSelected(router.state.location.search)).toBeUndefined();
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
    // The handle keeps only the arrows: Esc still closes the pane.
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(isPaneShown()).toBe(false);
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

  it("moves the split a frame after the click or key, and with it under Reduce motion", async () => {
    await openIntake();
    const split = getList().parentElement!;
    // No frame passes until the test lets the held ones pass.
    let frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => frames.push(callback));
    const passFrames = (): void => {
      act(() => {
        while (frames.length > 0) {
          const held = frames;
          frames = [];
          for (const callback of held) callback(performance.now());
        }
      });
    };
    await userEvent.click(getRow(REVIEW));
    await findPane();
    expect(split.classList.contains("has-pane")).toBe(false);
    passFrames();
    expect(split.classList.contains("has-pane")).toBe(true);

    // Esc closes the pane at once, and the list widens a frame later.
    await userEvent.keyboard("{Escape}");
    expect(isPaneShown()).toBe(false);
    expect(split.classList.contains("has-pane")).toBe(true);
    passFrames();
    expect(split.classList.contains("has-pane")).toBe(false);
    requestFrame.mockRestore();

    // Under Reduce motion the split opens with the click.
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation(
        (query) => ({ matches: query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList,
      );
    await userEvent.click(screen.getByRole("button", { name: "Signal pane" }));
    expect(isPaneShown()).toBe(true);
    expect(split.classList.contains("has-pane")).toBe(true);
    matchMedia.mockRestore();
  });
});

describe("Intake's views", () => {
  /** A signal snoozed until two days from now, which Later lists. */
  const SNOOZED = buildSignal("01a06d02-7a00-7000-8000-000000000021", 21, "08:00", {
    title: "Bump the TLS library",
    actions: [DONE],
    snooze: {
      until: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      snoozedAt: new Date().toISOString(),
    },
  });
  /** A signal resolved now, so the foot counts it as cleared today. */
  const CLEARED = resolve(
    buildSignal("01a06d02-7a00-7000-8000-000000000022", 22, "07:00", { title: "Old review" }),
    "user",
    "Approved #22",
    new Date().toISOString(),
  );

  it("switches to Later, which shows when each signal comes back, and clears the checks", async () => {
    const { router } = await openIntake("/intake", storeSignals([...SIGNALS, SNOOZED]).handlers);
    const views = screen.getByRole("group", { name: "View" });
    expect(
      within(views)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["To do3", "Later1", "Done", "Everything"]);
    await userEvent.click(within(getItem(REVIEW)).getByRole("checkbox"));
    await userEvent.click(within(views).getByRole("button", { name: /^Later/ }));
    expect(router.state.location.search).toEqual({ view: "later" });
    await waitFor(() => {
      expect(getRow(SNOOZED)).not.toBeNull();
    });
    // The day heading names the day; the row shows only the time it comes back.
    expect(getItem(SNOOZED).querySelector(".ask-until time")!.textContent).toMatch(/^\d\d:\d\d$/);
    expect(getList().querySelectorAll(".ask-item")).toHaveLength(1);
    expect(screen.queryByRole("toolbar", { name: "Checked rows" })).toBeNull();
    await userEvent.click(within(views).getByRole("button", { name: /^To do/ }));
    expect(within(getItem(REVIEW)).getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("puts a signal back on To do with U on Later", async () => {
    const { calls } = await openIntake(
      `/intake?view=later&signal=${SNOOZED.id}`,
      storeSignals([...SIGNALS, SNOOZED]).handlers,
    );
    await findPane();
    act(() => {
      getRow(SNOOZED).focus();
    });
    await userEvent.keyboard("u");
    await waitFor(() => {
      expect(findMove(calls, "unsnooze")?.body).toEqual({ signalIds: [SNOOZED.id] });
    });
    expect((await findToast()).textContent).toBe("Back on To do");
    expect(screen.getByText("Nothing snoozed.", { exact: false })).toBeTruthy();
  });

  it("snoozes again on Later with H, and keeps the selection and the row", async () => {
    const { calls, router } = await openIntake(
      `/intake?view=later&signal=${SNOOZED.id}`,
      storeSignals([...SIGNALS, SNOOZED]).handlers,
    );
    const pane = await findPane();
    expect(pane.querySelector(".ad-flag")!.textContent).toMatch(/^Snoozed at \d\d:\d\d until /);
    act(() => {
      getRow(SNOOZED).focus();
    });
    await userEvent.keyboard("h");
    await userEvent.keyboard("3");
    await waitFor(() => {
      expect(findMove(calls, "snooze")?.body).toMatchObject({ signalIds: [SNOOZED.id] });
    });
    expect((await findToast()).textContent).toMatch(/^Snoozed until /);
    expect(readSelected(router.state.location.search)).toBe(SNOOZED.id);
    expect(getRow(SNOOZED)).not.toBeNull();
  });

  it("lists Done with each outcome and no controls, and counts what was cleared today", async () => {
    await openIntake("/intake", storeSignals([...SIGNALS, CLEARED]).handlers);
    const foot = await screen.findByText(/cleared today/);
    expect(foot.textContent).toBe("1 cleared today. See Done.");
    await userEvent.click(within(foot).getByRole("link", { name: "See Done" }));
    await waitFor(() => {
      expect(getRow(CLEARED)).not.toBeNull();
    });
    expect(getItem(CLEARED).querySelector(".ask-sub")!.textContent).toBe("Approved #22");
    expect(within(getItem(CLEARED)).queryAllByRole("button")).toHaveLength(1);
    expect(getList().querySelector(".asks-rows--quiet")).not.toBeNull();
  });

  it("has no foot when nothing was cleared today", async () => {
    await openIntake();
    expect(screen.queryByText(/cleared today/)).toBeNull();
  });
});

describe("Intake's moves", () => {
  /** A proposal, which has no Done: Done in the bulk bar keeps it. */
  const PROPOSAL = buildSignal("01a06d02-7a00-7000-8000-000000000031", 0, "12:00", {
    kind: "proposal",
    title: "Group the webhook alerts",
    origin: { type: "api", actor: "user", eventIds: [], reason: "Seen twice" },
  });

  it("gives each row its moves, with Done's describe line as its tooltip", async () => {
    await openIntake();
    const moves = (signal: Signal) =>
      [...getItem(signal).querySelectorAll(".ask-act")].map((button) =>
        button.getAttribute("aria-label"),
      );
    expect(moves(ALERT)).toEqual(["Snooze", "Not urgent"]);
    expect(moves(REVIEW)).toEqual(["Snooze", "Done"]);
    expect(
      within(getItem(REVIEW)).getByRole("button", { name: "Done" }).getAttribute("title"),
    ).toBe("Marks it done  E");
  });

  it("moves a Now signal to Signals with Not urgent", async () => {
    const { calls } = await openIntake();
    await clickRowMove(ALERT, "Not urgent");
    await waitFor(() => {
      expect(findMove(calls, "lower-priority")?.body).toEqual({ signalIds: [ALERT.id] });
    });
    expect((await findToast()).textContent).toBe("Moved out of Now");
    await waitFor(() => {
      expect(
        within(getList())
          .getAllByRole("heading")
          .map((heading) => heading.textContent),
      ).toEqual(["Signals3"]);
    });
    expect(getItem(ALERT).querySelector(".ask-high")).not.toBeNull();
  });

  it("snoozes the selected signal with H and a choice's key", async () => {
    // The second choice depends on the time of day, so the clock is set to a
    // Tuesday morning. Only the date is faked; timers still run.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-13T08:30:00Z") });
    const { calls } = await openIntake(`/intake?signal=${MENTION.id}`);
    await findPane();
    act(() => {
      getRow(MENTION).focus();
    });
    await userEvent.keyboard("h");
    // jsdom has no popover API, so the menu counts as hidden there and has no
    // accessible name; it is found by its class instead.
    const menu = document.querySelector<HTMLElement>(".asks-snooze[role=menu]")!;
    expect(menu.getAttribute("aria-label")).toBe("Snooze until");
    expect(
      within(menu)
        .getAllByRole("menuitem", { hidden: true })
        .map((item) => item.querySelector("span")!.textContent),
    ).toEqual(["In 1 hour", "This afternoon", "Tomorrow", "Monday", "Pick a time…"]);
    await userEvent.keyboard("3");
    await waitFor(() => {
      expect(findMove(calls, "snooze")).toBeDefined();
    });
    const { signalIds, until } = findMove(calls, "snooze")!.body as {
      signalIds: string[];
      until: string;
    };
    expect(signalIds).toEqual([MENTION.id]);
    expect(until).toMatch(/T09:00:00(\.000)?Z$/);
    expect((await findToast()).textContent).toBe("Snoozed until tomorrow 09:00");
    expect(document.querySelector(".asks-snooze")).toBeNull();
  });

  it("checks rows with X and ⇧J, and Done in the bar sends only the rows that have it", async () => {
    const { calls } = await openIntake(
      `/intake?signal=${REVIEW.id}`,
      storeSignals([...SIGNALS, PROPOSAL]).handlers,
    );
    await findPane();
    act(() => {
      getRow(REVIEW).focus();
    });
    // The list reads Now, then Signals: the review, the mention, the proposal.
    await userEvent.keyboard("x");
    await userEvent.keyboard("{Shift>}J{/Shift}");
    await userEvent.keyboard("{Shift>}J{/Shift}");
    const bar = screen.getByRole("toolbar", { name: "Checked rows" });
    expect(bar.querySelector(".asks-toast-text")!.textContent).toBe("3 selected");
    const done = within(bar).getByRole("button", { name: /^Done/ });
    await userEvent.hover(done);
    expect(bar.querySelector(".asks-toast-text")!.textContent).toBe("Done 2 · keeps 1 proposal");
    expect(done.getAttribute("title")).toBe("Marks 2 of 3 done. 1 proposal needs its own answer");
    expect(getItem(PROPOSAL).classList.contains("is-kept")).toBe(true);
    expect(getItem(REVIEW).classList.contains("is-acted")).toBe(true);
    await userEvent.click(done);
    await waitFor(() => {
      expect(findMove(calls, "mark-done")?.body).toEqual({ signalIds: [REVIEW.id, MENTION.id] });
    });
    expect((await findToast()).textContent).toBe("Marked 2 done. Kept 1 proposal");
    await waitFor(() => {
      expect(bar.querySelector(".asks-toast-text")!.textContent).toBe("1 selected");
    });
    expect(within(getItem(PROPOSAL)).getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("clears the checks with Esc before it closes the pane", async () => {
    await openIntake(`/intake?signal=${REVIEW.id}`);
    await findPane();
    act(() => {
      getRow(REVIEW).focus();
    });
    await userEvent.keyboard("x");
    expect(screen.getByRole("toolbar", { name: "Checked rows" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar", { name: "Checked rows" })).toBeNull();
    expect(isPaneShown()).toBe(true);
  });

  it("stays on the view the user switched to while a move was being sent", async () => {
    const { handlers } = storeSignals(SIGNALS);
    let releaseAnswer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const markDone = handlers["POST /api/v1/signals/mark-done"] as Exclude<Handler, Answer>;
    const { calls, router } = await openIntake(`/intake?signal=${REVIEW.id}`, {
      ...handlers,
      // The controller marks the signal done at once, so Done lists it, but
      // its answer arrives only once the test lets it.
      "POST /api/v1/signals/mark-done": async (call) => {
        const answer = await markDone(call);
        await answered;
        return answer;
      },
    });
    await findPane();
    act(() => {
      getRow(REVIEW).focus();
    });
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(findMove(calls, "mark-done")).toBeDefined();
    });
    const views = screen.getByRole("group", { name: "View" });
    await userEvent.click(within(views).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(getRow(REVIEW)).not.toBeNull();
    });
    await userEvent.click(getRow(REVIEW));
    releaseAnswer();
    expect((await findToast()).textContent).toBe(`Done · ${REVIEW.title}`);
    // The move's last step runs after the toast shows; one turn of the event
    // loop lets it run.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(router.state.location.search).toEqual({ view: "done", signal: REVIEW.id });
  });

  it("shows a failed move in the toast's place, and the row stays", async () => {
    await openIntake("/intake", {
      ...storeSignals(SIGNALS).handlers,
      "POST /api/v1/signals/mark-done": {
        status: 500,
        body: buildErrorBody("internal", "The database is busy."),
      },
    });
    await clickRowMove(REVIEW, "Done");
    const toast = await findToast();
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.classList.contains("asks-toast--fail")).toBe(true);
    expect(toast.textContent).toBe("Couldn't mark done: The database is busy.");
    expect(toast.querySelector(".mark--failed")).not.toBeNull();
    expect(getRow(REVIEW)).not.toBeNull();
  });
});

const SIGNAL_FACT_ID = "01a06d02-7a00-7000-8000-0000000000a1";
const TASK_ID = "01a06d02-7b00-7000-8000-0000000000a1";
const SUBSCRIPTION_ID = "01a06d02-7c00-7000-8000-0000000000a1";
const SESSION_ID = "01a06d02-7d00-7000-8000-0000000000a1";

/** The Connection the Everything events came through, so the pane can name it. */
const EVENTS_CONNECTION: Connection = {
  ...FIXTURE_GITHUB_CONNECTION,
  id: CONNECTION_ID,
  label: "acme-bot",
};

/** Builds a GitHub event with no handling, received a minute after the event with the id before it. */
const buildListedEvent = (id: number, over: Partial<EventWithFacts> = {}): EventWithFacts => ({
  ...buildEvent(id, `https://github.com/acme/webshop/pull/${String(id)}`),
  receivedAt: new Date(Date.UTC(2026, 9, 10, 12, 0) - (1000 - id) * 60_000).toISOString(),
  signals: [],
  resolvedSignals: [],
  tasks: [],
  knownBy: [],
  ...over,
});

/**
 * Returns the handlers that play `event.query` over `stored`, newest first,
 * `pageSize` events to a page, with a cursor to the next page while events
 * are left. The text, source and handling filters work as the controller's do,
 * for the two handlings the tests filter by.
 */
const storeEvents = (stored: ReadonlyArray<EventWithFacts>, pageSize = 20) => {
  const handlers: Record<string, Handler> = {
    "GET /api/v1/connections": { body: { items: [EVENTS_CONNECTION] } },
    "GET /api/v1/plugins": { body: [GITHUB] },
    "GET /api/v1/events": (call) => {
      const query = new URLSearchParams(call.search);
      const text = query.get("text")?.toLowerCase();
      const source = query.get("source");
      const handlings = query.getAll("handling");
      const before = Number(query.get("cursor") ?? Infinity);
      const matching = stored
        .filter(
          (event) =>
            event.id < before &&
            (source === null || event.source === source) &&
            (text === undefined ||
              `${event.title ?? ""} ${event.author ?? ""}`.toLowerCase().includes(text)) &&
            (handlings.length === 0 ||
              (handlings.includes("raised-signal") && event.signals.length > 0) ||
              (handlings.includes("no-action") &&
                event.signals.length + event.tasks.length + event.knownBy.length === 0)),
        )
        .toSorted((a, b) => b.id - a.id);
      const items = matching.slice(0, pageSize);
      return {
        body: {
          items,
          ...(matching.length > pageSize ? { nextCursor: String(items.at(-1)!.id) } : {}),
        },
      };
    },
  };
  for (const event of stored) handlers[`GET /api/v1/events/${String(event.id)}`] = { body: event };
  return handlers;
};

/** Opens Intake at `path` on top of the signals' handlers, with `events` behind Everything. */
const openEverything = (
  events: ReadonlyArray<EventWithFacts>,
  path = "/intake?view=everything",
  pageSize = 20,
) => openIntake(path, { ...storeSignals(SIGNALS).handlers, ...storeEvents(events, pageSize) });

const getEventList = () => screen.getByRole("region", { name: "Events" });
const getEventRow = (event: EventWithFacts) =>
  getEventList().querySelector<HTMLElement>(`[data-event-id="${String(event.id)}"]`)!;
const findEventPane = () => screen.findByRole("region", { name: "The open event" });
const isEventPaneShown = (): boolean => {
  const pane = screen.queryByRole("region", { name: "The open event" });
  return pane !== null && !pane.hasAttribute("inert");
};
/** Returns the titles of the rows the list draws, top to bottom. */
const readEventTitles = () =>
  [...getEventList().querySelectorAll(".ask-title")].map((title) => title.textContent);
/** Returns the requests that read the events listing, each with its query as a map of lists. */
const findEventReads = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.method === "GET" && call.path === "/api/v1/events")
    .map((call) => {
      const query = new URLSearchParams(call.search);
      return Object.fromEntries([...new Set(query.keys())].map((key) => [key, query.getAll(key)]));
    });

describe("Intake's Everything view", () => {
  it("switches to Everything, which reads Intake's events newest first and states the horizon", async () => {
    const events = [1, 2, 3].map((id) => buildListedEvent(id));
    const { calls, router } = await openEverything(events, "/intake");
    const views = screen.getByRole("group", { name: "View" });
    await userEvent.click(within(views).getByRole("button", { name: "Everything" }));

    await waitFor(() => {
      expect(getEventRow(events[0]!)).not.toBeNull();
    });
    expect(router.state.location.search).toEqual({ view: "everything" });
    expect(readEventTitles()).toEqual(["Pull request #3", "Pull request #2", "Pull request #1"]);
    expect(findEventReads(calls)).toEqual([{ intake: ["true"] }]);
    expect(screen.getByText("Events from the last 90 days")).not.toBeNull();
    // The Everything screen draws its own switcher, so the one clicked is gone.
    const everythingViews = screen.getByRole("group", { name: "View" });
    expect(
      within(everythingViews)
        .getByRole("button", { name: "Everything" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("draws a row's mark, title, author, first two handlings and the count of the rest", async () => {
    const busy = buildListedEvent(1, {
      signals: [
        {
          signalId: SIGNAL_FACT_ID,
          kind: "github/review-requested",
          status: "open",
          title: "Review",
        },
      ],
      tasks: [{ taskId: TASK_ID, title: "Fix the flaky test" }],
      knownBy: [
        {
          subscriptionId: SUBSCRIPTION_ID,
          holder: { kind: "session", id: SESSION_ID },
          title: "Release thread",
        },
      ],
    });
    await openEverything([busy]);
    const row = await waitFor(() => {
      const found = getEventRow(busy);
      expect(found).not.toBeNull();
      return found;
    });
    expect(row.querySelector(".ask-mark svg path")?.getAttribute("d")).toBe(GITHUB_MARK_PATH);
    expect(row.querySelector(".ask-title")!.textContent).toBe("Pull request #1");
    expect(row.querySelector(".ask-sub")!.textContent).toBe(
      "Marta · → signal · on your To do list · → Fix the flaky test · +1",
    );
    expect(row.querySelector("input, [role=checkbox], .ask-acts")).toBeNull();
  });

  it("titles an event that has no title by its kind", async () => {
    const untitled = buildListedEvent(1, { title: null, author: null });
    await openEverything([untitled]);
    await waitFor(() => {
      expect(getEventRow(untitled).querySelector(".ask-title")!.textContent).toBe(
        "github.notification",
      );
    });
  });

  it("waits for typing to pause, then searches with the text in the URL", async () => {
    const events = [
      buildListedEvent(1, { title: "Deploy failed" }),
      buildListedEvent(2, { title: "Mention in the sprint doc" }),
    ];
    const { calls, router } = await openEverything(events);
    await waitFor(() => {
      expect(getEventRow(events[0]!)).not.toBeNull();
    });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search events" }), "sprint");

    // No read carries the text while the user is still typing.
    expect(findEventReads(calls).some((read) => "text" in read)).toBe(false);
    await waitFor(() => {
      expect(findEventReads(calls).at(-1)).toEqual({ intake: ["true"], text: ["sprint"] });
    });
    expect(router.state.location.search).toEqual({ view: "everything", text: "sprint" });
    await waitFor(() => {
      expect(readEventTitles()).toEqual(["Mention in the sprint doc"]);
    });
  });

  it("says no event has come yet when the log is empty", async () => {
    await openEverything([]);
    expect(await screen.findByText("No events yet.")).not.toBeNull();
  });

  it("says no event matches when a search finds none", async () => {
    await openEverything([buildListedEvent(1)], "/intake?view=everything&text=nothing");
    expect(await screen.findByText("No events match.")).not.toBeNull();
  });

  it("filters by what came of an event, with a menu named What came of it", async () => {
    const raised = buildListedEvent(1, {
      title: "Review requested",
      signals: [
        {
          signalId: SIGNAL_FACT_ID,
          kind: "github/review-requested",
          status: "open",
          title: "Review",
        },
      ],
    });
    const quiet = buildListedEvent(2, { title: "Push to main" });
    const { calls, router } = await openEverything([raised, quiet]);
    await waitFor(() => {
      expect(getEventRow(quiet)).not.toBeNull();
    });
    const menu = screen.getByRole("combobox", { name: "What came of it" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "All events",
      "Raised a signal",
      "Ended a signal",
      "Evidence for a signal",
      "Added to a Task",
      "Known to running work",
      "No action",
    ]);

    await userEvent.selectOptions(menu, "raised-signal");

    await waitFor(() => {
      expect(findEventReads(calls).at(-1)).toEqual({
        intake: ["true"],
        handling: ["raised-signal"],
      });
    });
    expect(router.state.location.search).toEqual({
      view: "everything",
      handling: "raised-signal",
    });
    await waitFor(() => {
      expect(readEventTitles()).toEqual(["Review requested"]);
    });
  });

  it("narrows the list to a source when its tab is pressed", async () => {
    const events = [
      buildListedEvent(1, { source: "github" }),
      buildListedEvent(2, { source: "cron", connectionId: null, title: "Nightly" }),
    ];
    const { calls } = await openEverything(events);
    await waitFor(() => {
      expect(getEventRow(events[1]!)).not.toBeNull();
    });
    const tabs = screen.getByRole("navigation", { name: "Sources" });
    await userEvent.click(within(tabs).getByRole("button", { name: /GitHub/ }));

    await waitFor(() => {
      expect(findEventReads(calls).at(-1)).toEqual({ intake: ["true"], source: ["github"] });
    });
    await waitFor(() => {
      expect(getEventList().querySelector('[data-event-id="2"]')).toBeNull();
    });
    expect(getEventRow(events[0]!)).not.toBeNull();
  });

  it("reads the next page as the list is scrolled, and ends with a line when none is left", async () => {
    const events = Array.from({ length: 45 }, (_, index) => buildListedEvent(index + 1));
    const { calls } = await openEverything(events);
    await waitFor(() => {
      expect(getEventRow(events.at(-1)!)).not.toBeNull();
    });
    expect(screen.queryByText("No older events.")).toBeNull();

    const scroll = getEventList().querySelector<HTMLElement>(".asks-scroll")!;
    scroll.scrollTop = 100_000;
    fireEvent.scroll(scroll);

    await waitFor(() => {
      expect(findEventReads(calls).map((read) => read.cursor)).toEqual([undefined, ["26"], ["6"]]);
    });
    expect(await screen.findByText("No older events.")).not.toBeNull();
  });

  it("opens the pane with every handling of the event, each linked where the app has a screen", async () => {
    const busy = buildListedEvent(1, {
      signals: [
        { signalId: REVIEW.id, kind: "github/review-requested", status: "open", title: "Review" },
      ],
      resolvedSignals: [{ signalId: MENTION.id, title: "Mention", outcome: "Replied" }],
      tasks: [{ taskId: TASK_ID, title: "Fix the flaky test" }],
      knownBy: [
        {
          subscriptionId: SUBSCRIPTION_ID,
          holder: { kind: "session", id: SESSION_ID },
          title: "Release thread",
        },
      ],
      refs: ["github:pr:acme/webshop#1"],
    });
    const { router } = await openEverything([busy]);
    await waitFor(() => {
      expect(getEventRow(busy)).not.toBeNull();
    });
    expect(isEventPaneShown()).toBe(false);

    await userEvent.click(getEventRow(busy));

    const pane = await findEventPane();
    expect(router.state.location.search).toEqual({ view: "everything", event: 1 });
    expect(isEventPaneShown()).toBe(true);
    expect(pane.querySelector(".ad-title")!.textContent).toBe("Pull request #1");
    expect(within(pane).getByRole("heading", { name: "What came of it" })).not.toBeNull();
    const blocks = [...pane.querySelectorAll(".ad-came-list .b-work")];
    expect(blocks.map((block) => block.textContent)).toEqual([
      "Raised a signal→ signalon your To do list",
      "Ended a signalended MentionReplied",
      "Added to a Task→ Fix the flaky test",
      "Known to running workknownRelease thread",
    ]);
    expect(blocks.map((block) => block.getAttribute("href"))).toEqual([
      `/intake?signal=${REVIEW.id}`,
      `/intake?view=done&signal=${MENTION.id}`,
      null,
      `/threads/${SESSION_ID}`,
    ]);
    expect(pane.querySelector(".b-fields")!.textContent).toBe(
      "Connectionacme-botReferencesgithub:pr:acme/webshop#1",
    );
    const open = within(pane).getByRole("link", { name: /Open in GitHub/ });
    expect(open.getAttribute("href")).toBe("https://github.com/acme/webshop/pull/1");
  });

  it("links the pane's kind to its row on Settings > Intake, on the event's Connection", async () => {
    const event = buildListedEvent(1);
    await openEverything([event], "/intake?view=everything&event=1");
    const pane = await findEventPane();

    const href = new URL(
      pane.querySelector(".ad-kind a.src")!.getAttribute("href")!,
      "http://app.test",
    );
    expect(href.pathname).toBe("/settings/intake");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      kind: "github.notification",
      connection: CONNECTION_ID,
    });
  });

  it("opens an event the list has not read from a link, with its fields and no handlings", async () => {
    const events = Array.from({ length: 200 }, (_, index) => buildListedEvent(index + 1));
    await openEverything(events, "/intake?view=everything&event=3", 5);
    const pane = await findEventPane();

    await waitFor(() => {
      expect(pane.querySelector(".ad-title")!.textContent).toBe("Pull request #3");
    });
    expect(within(pane).queryByRole("heading", { name: "What came of it" })).toBeNull();
  });

  it("moves the selection with J, K and the arrows, and closes the pane and then the selection with Esc", async () => {
    const events = [1, 2, 3].map((id) => buildListedEvent(id));
    const { router } = await openEverything(events);
    await waitFor(() => {
      expect(getEventRow(events[2]!)).not.toBeNull();
    });
    await userEvent.click(getEventRow(events[2]!));
    await findEventPane();

    await userEvent.keyboard("j");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ view: "everything", event: 2 });
    });
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ view: "everything", event: 1 });
    });
    await userEvent.keyboard("k");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ view: "everything", event: 2 });
    });

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(isEventPaneShown()).toBe(false);
    });
    expect(router.state.location.search).toEqual({ view: "everything", event: 2 });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ view: "everything" });
    });
  });

  it("draws no count on the view and no controls on a row", async () => {
    await openEverything([buildListedEvent(1)]);
    await waitFor(() => {
      expect(getEventList().querySelector(".ask-row")).not.toBeNull();
    });
    const views = screen.getByRole("group", { name: "View" });
    expect(
      within(views).getByRole("button", { name: "Everything" }).querySelector("small"),
    ).toBeNull();
    expect(getEventList().querySelector(".ask-check, .ask-acts")).toBeNull();
  });
});
