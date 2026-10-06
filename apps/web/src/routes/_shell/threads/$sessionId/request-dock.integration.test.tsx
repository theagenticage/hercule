/**
 * Tests the Request dock, the status card and the brief card against a
 * stubbed controller: paging through the session's open Requests, naming the
 * subagent that asks, reaching that subagent's page and its Stop, and what a
 * subagent's page shows at its top and its foot.
 *
 * They drive the app only through `renderApp` and the `LiveStub`.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildApprovalCard } from "@hercule/client-core";
import type { Session, SessionRequest, Subagent, TranscriptRow } from "@hercule/contract";
import { readPageText, renderApp, stubApi, type Call, type Handler } from "../../../../app/testing";

const SESSION_ID = "01a06d02-b100-7000-8000-000000000002";

const BASE_SESSION: Session = {
  id: SESSION_ID,
  title: "Get the release ready",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "01a06d02-2000-7000-8000-000000000001",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: "01a06d02-3000-7000-8000-000000000001",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  createdAt: "2026-10-06T09:59:00.000Z",
  startedAt: "2026-10-06T09:59:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-10-06T10:01:03.000Z",
  unenforced: [],
};

const buildSession = (overrides: Partial<Session>): Session => ({ ...BASE_SESSION, ...overrides });

/** Builds a subagent of the session that started at 10:00 and still runs, with `over` applied. */
const buildSubagent = (over: Partial<Subagent> & { readonly id: string }): Subagent => ({
  sessionId: SESSION_ID,
  status: "running",
  toolCalls: 0,
  startedAt: "2026-10-06T10:00:00.000Z",
  ...over,
});

const PLAN = buildSubagent({
  id: "plan-migration",
  description: "Plan the database migration",
  agentType: "Plan",
  usage: { inputTokens: 6000, outputTokens: 200 },
});
const DRY_RUN = buildSubagent({
  id: "dry-run-deploy",
  parentSubagentId: PLAN.id,
  description: "Dry-run the deploy script",
});
const SCHEMA = buildSubagent({
  id: "schema-history",
  parentSubagentId: PLAN.id,
  description: "Read the schema history",
});

/** The main agent asks to run a command. */
const MAIN_REQUEST: SessionRequest = {
  requestId: "req-main",
  itemId: "tool-main",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "stripe listen" },
};

/** The nested subagent asks to run a command. */
const DRY_RUN_REQUEST: SessionRequest = {
  requestId: "req-dry-run",
  itemId: "tool-dry-run",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "./scripts/deploy.sh --dry-run" },
  subagentId: DRY_RUN.id,
};

/** The planning subagent asks a question, which offers no decision. */
const PLAN_QUESTION: SessionRequest = {
  requestId: "req-plan",
  itemId: "tool-plan",
  kind: "question",
  detail: {
    questions: [
      {
        question: "How much downtime is acceptable?",
        header: "Downtime",
        options: [{ label: "None", description: "roll out online" }],
        multiSelect: false,
      },
    ],
  },
  subagentId: PLAN.id,
};

const BRIEF = "Plan the migration that adds the archived_at column, and how to roll it out safely.";

/** Builds a transcript of one turn whose user message is `text`, numbered from 0. */
const buildBriefTurn = (text: string): TranscriptRow[] =>
  [
    { _tag: "turn.started", turnId: "s1" },
    { _tag: "item.started", turnId: "s1", itemId: "u1", kind: "user_message", detail: { text } },
    {
      _tag: "item.completed",
      turnId: "s1",
      itemId: "u1",
      kind: "user_message",
      status: "completed",
      detail: { text },
    },
  ].map((event, position) => {
    const at = "2026-10-06T10:00:00.000Z";
    return {
      position,
      at,
      event: { ...event, eventId: `e${String(position)}`, sessionId: SESSION_ID, at },
    } as TranscriptRow;
  });

/**
 * The controller as the tests see it. `state` holds the session and its
 * subagents, which a test changes before it pushes a live nudge; every read
 * answers from it.
 */
interface ControllerState {
  session: Session;
  subagents: readonly Subagent[];
}

const buildController = (
  state: ControllerState,
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: "UTC" },
    },
  },
  [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({ body: state.session }),
  [`GET /api/v1/sessions/${SESSION_ID}/subagents`]: () => ({ body: { items: state.subagents } }),
  // A subagent's transcript is its brief; the session's own is empty.
  [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: (call: Call) => ({
    body: { items: call.search.includes("subagentId=") ? buildBriefTurn(BRIEF) : [] },
  }),
  [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [] } },
  "GET /api/v1/providers": { body: [] },
  "GET /api/v1/runners": { body: { items: [] } },
  "GET /api/v1/profiles": { body: { items: [] } },
  "GET /api/v1/assistants": { body: { items: [] } },
  ...extra,
});

const openApp = async (
  state: ControllerState,
  path = `/threads/${SESSION_ID}`,
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController(state, extra));
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Returns the line above the card that pages and names the asker, or null when there is none. */
const queryAskerLine = (): HTMLElement | null =>
  screen.queryByText(/^asks\b|^The main agent asks$/)?.closest<HTMLElement>("div") ?? null;

/** Returns the button of the card's `decision` row for `request`. */
const findAnswer = (request: SessionRequest, decision: string): Promise<HTMLElement> => {
  const row = buildApprovalCard(request).rows.find((each) => each.id === decision);
  if (row === undefined) throw new Error(`the card offers no ${decision} row`);
  return screen.findByRole("button", { name: (name) => name.includes(row.label) });
};

describe("Request dock: paging through the thread's open Requests", () => {
  it("pages through a subagent's and the main agent's Requests, and stays on a sensible one as they are answered in reverse order", async () => {
    const user = userEvent.setup();
    const state: ControllerState = {
      session: buildSession({ status: "busy", openRequests: [DRY_RUN_REQUEST, MAIN_REQUEST] }),
      subagents: [PLAN, DRY_RUN],
    };
    const { live, api } = await openApp(state, undefined, {
      [`POST /api/v1/sessions/${SESSION_ID}/respond-to-approval-request`]: () => ({
        body: state.session,
      }),
    });

    // The oldest first: the subagent's, named with its parent.
    await screen.findByText("./scripts/deploy.sh --dry-run");
    expect(readPageText(queryAskerLine())).toBe(
      "‹1 of 2›Dry-run the deploy script asks · subagent of Plan the database migrationOpen subagent",
    );
    expect(screen.getByRole("button", { name: "Previous Request" })).toHaveProperty(
      "disabled",
      true,
    );

    await user.click(screen.getByRole("button", { name: "Next Request" }));
    await screen.findByText("stripe listen");
    expect(screen.queryByText("./scripts/deploy.sh --dry-run")).toBeNull();
    expect(readPageText(queryAskerLine())).toBe("‹2 of 2›The main agent asks");
    expect(screen.queryByRole("link", { name: "Open subagent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Next Request" })).toHaveProperty("disabled", true);

    // Answering the second leaves the first, which is the one still open.
    await user.click(await findAnswer(MAIN_REQUEST, "allow"));
    await waitFor(() => {
      expect(api.calls.some((call) => call.path.endsWith("/respond-to-approval-request"))).toBe(
        true,
      );
    });
    state.session = buildSession({ status: "busy", openRequests: [DRY_RUN_REQUEST] });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });
    await screen.findByText("./scripts/deploy.sh --dry-run");
    expect(screen.queryByText("stripe listen")).toBeNull();
    // A lone subagent's Request keeps the line, without arrows.
    expect(readPageText(queryAskerLine())).toBe(
      "Dry-run the deploy script asks · subagent of Plan the database migrationOpen subagent",
    );
    expect(screen.queryByRole("button", { name: "Next Request" })).toBeNull();

    await user.click(await findAnswer(DRY_RUN_REQUEST, "allow"));
    state.session = buildSession({ status: "busy", openRequests: [] });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });
    await waitFor(() => {
      expect(screen.queryByText("./scripts/deploy.sh --dry-run")).toBeNull();
    });
    expect(queryAskerLine()).toBeNull();
  });

  it("keeps showing the Request the user paged to when an older one closes", async () => {
    const user = userEvent.setup();
    const state: ControllerState = {
      session: buildSession({ status: "busy", openRequests: [DRY_RUN_REQUEST, MAIN_REQUEST] }),
      subagents: [PLAN, DRY_RUN],
    };
    const { live } = await openApp(state);
    await user.click(await screen.findByRole("button", { name: "Next Request" }));
    await screen.findByText("stripe listen");

    state.session = buildSession({ status: "busy", openRequests: [MAIN_REQUEST] });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Next Request" })).toBeNull();
    });
    expect(screen.getByText("stripe listen")).toBeDefined();
  });

  it("draws no line above a lone Request of the main agent", async () => {
    await openApp({
      session: buildSession({ status: "busy", openRequests: [MAIN_REQUEST] }),
      subagents: [],
    });
    await screen.findByText("stripe listen");
    expect(queryAskerLine()).toBeNull();
    expect(screen.queryByRole("button", { name: "Next Request" })).toBeNull();
  });

  it("opens the asking subagent's page from Open subagent", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({
      session: buildSession({ status: "idle", openRequests: [DRY_RUN_REQUEST] }),
      subagents: [PLAN, DRY_RUN],
    });

    await user.click(await screen.findByRole("link", { name: "Open subagent" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}/subagents/${DRY_RUN.id}`);
    });
    // Its own Request docks above its status card, with no asker line,
    // because the page already names the subagent.
    await screen.findByText("Waiting on you");
    expect(screen.getByText("./scripts/deploy.sh --dry-run")).toBeDefined();
    expect(queryAskerLine()).toBeNull();
  });
});

describe("Request dock: stopping the subagent that asks", () => {
  it("reaches the asking subagent's Stop in two clicks with the main agent idle, and stopping closes its question", async () => {
    const user = userEvent.setup();
    const state: ControllerState = {
      session: buildSession({ status: "idle", openRequests: [PLAN_QUESTION] }),
      subagents: [PLAN, DRY_RUN, SCHEMA],
    };
    const { live, api } = await openApp(state, undefined, {
      [`POST /api/v1/sessions/${SESSION_ID}/interrupt`]: () => ({ body: state.session }),
    });
    await screen.findByText("How much downtime is acceptable?");
    // The main agent is idle, so the composer offers no Stop.
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();

    // Click one.
    await user.click(screen.getByRole("link", { name: "Open subagent" }));
    // Click two.
    await user.click(await screen.findByRole("button", { name: "Stop with 2 below" }));

    await waitFor(() => {
      expect(
        api.calls.find((call) => call.path === `/api/v1/sessions/${SESSION_ID}/interrupt`),
      ).toMatchObject({ method: "POST", body: { subagentId: PLAN.id } });
    });

    // The controller cancels the question and stops the subagent and the two
    // below it; the live topics say so.
    state.session = buildSession({ status: "idle", openRequests: [] });
    state.subagents = [PLAN, DRY_RUN, SCHEMA].map((each) => ({
      ...each,
      status: "stopped",
      endedAt: "2026-10-06T10:02:54.000Z",
    }));
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
      live.push("subagent", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });
    await screen.findByText("Stopped after 2m 54s");
    expect(screen.queryByText("How much downtime is acceptable?")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  });
});

describe("Status card", () => {
  /** Opens the page of `subagent` among `subagents` and returns its status card. */
  const openStatusCard = async (
    subagent: Subagent,
    subagents: readonly Subagent[],
    openRequests: readonly SessionRequest[] = [],
  ): Promise<HTMLElement> => {
    await openApp(
      { session: buildSession({ status: "idle", openRequests }), subagents },
      `/threads/${SESSION_ID}/subagents/${subagent.id}`,
    );
    const open = await screen.findByRole("link", { name: "Open parent" });
    const card = open.closest<HTMLElement>('[class*="rounded-[14px]"]');
    if (card === null) throw new Error("the status card was not found");
    return card;
  };

  it("shows a running subagent's time in the live hue, with Stop and no tooltip when nothing runs below it", async () => {
    const card = await openStatusCard(DRY_RUN, [PLAN, DRY_RUN]);
    const headline = within(card).getByText(/^Working for /);
    expect(headline.className).toContain("text-live");
    expect(readPageText(card)).toContain(
      "Subagent of Plan the database migration · takes no messages",
    );
    const stop = within(card).getByRole("button", { name: "Stop" });
    expect(stop.getAttribute("title")).not.toMatch(/subagent/);
    expect(within(card).getByRole("link", { name: "Open parent" }).getAttribute("href")).toBe(
      `/threads/${SESSION_ID}/subagents/${PLAN.id}`,
    );
  });

  it("says Stop with N below, with a tooltip, when the subagent has subagents of its own", async () => {
    const card = await openStatusCard(PLAN, [PLAN, DRY_RUN, SCHEMA]);
    const stop = within(card).getByRole("button", { name: "Stop with 2 below" });
    expect(stop.getAttribute("title")).toBe("Also stops the 2 subagents below it");
    expect(readPageText(card)).toContain(
      "Subagent of the main agent · 6.2k tokens · takes no messages",
    );
    expect(within(card).getByRole("link", { name: "Open parent" }).getAttribute("href")).toBe(
      `/threads/${SESSION_ID}`,
    );
  });

  it("says Waiting on you in the attention hue while one of its Requests is open", async () => {
    const card = await openStatusCard(DRY_RUN, [PLAN, DRY_RUN], [DRY_RUN_REQUEST]);
    expect(within(card).getByText("Waiting on you").className).toContain("text-attn");
    expect(within(card).getByRole("button", { name: "Stop" })).toBeDefined();
  });

  it.each([
    ["completed", "Done in 2m 20s", "text-muted"],
    ["failed", "Failed after 2m 20s", "text-fail"],
    ["stopped", "Stopped after 2m 20s", "text-muted"],
  ] as const)("shows a %s subagent as %s, with no Stop", async (status, headline, hue) => {
    const ended = { ...DRY_RUN, status, endedAt: "2026-10-06T10:02:20.000Z" };
    const card = await openStatusCard(ended, [PLAN, ended]);
    expect(within(card).getByText(headline).className).toContain(hue);
    expect(within(card).queryByRole("button", { name: /^Stop/ })).toBeNull();
  });
});

describe("A subagent's page, opened from its URL", () => {
  it("opens with the brief and its parent, does not repeat the brief as a message, and has the status card in the composer's place", async () => {
    const user = userEvent.setup();
    await openApp(
      { session: buildSession({ status: "busy" }), subagents: [PLAN, DRY_RUN] },
      `/threads/${SESSION_ID}/subagents/${PLAN.id}`,
    );

    const brief = await screen.findByRole("button", { name: BRIEF });
    expect(screen.getAllByText(BRIEF)).toHaveLength(1);
    const card = brief.parentElement as HTMLElement;
    expect(readPageText(card)).toBe(`Brief from the main agent · Plan agent${BRIEF}`);
    // The brief is cut to three lines until it is clicked.
    expect(brief.firstElementChild?.className).toContain("line-clamp-3");
    await user.click(brief);
    expect(brief.firstElementChild?.className).not.toContain("line-clamp-3");
    expect(brief.getAttribute("aria-expanded")).toBe("true");

    expect(screen.getByRole("link", { name: "Open parent" })).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("pages through the subagent's own Requests with the arrows alone, leaving out the session's other Requests", async () => {
    const second: SessionRequest = { ...DRY_RUN_REQUEST, requestId: "req-dry-run-2" };
    await openApp(
      {
        session: buildSession({
          status: "busy",
          openRequests: [MAIN_REQUEST, DRY_RUN_REQUEST, second],
        }),
        subagents: [PLAN, DRY_RUN],
      },
      `/threads/${SESSION_ID}/subagents/${DRY_RUN.id}`,
    );
    const next = await screen.findByRole("button", { name: "Next Request" });
    expect(readPageText(next.closest("div"))).toBe("‹1 of 2›");
    expect(screen.queryByText("stripe listen")).toBeNull();
  });
});
