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
import type { SessionRequest, Subagent, TranscriptRow } from "@hercule/contract";
import { readPageText, renderApp, stubApi, type Call, type Handler } from "../../../../app/testing";
import {
  SESSION_ID,
  buildController,
  buildRequest,
  buildSession,
  buildSubagent,
  type ControllerState,
} from "./-fixtures";

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
const MAIN_REQUEST = buildRequest("req-main", undefined, "stripe listen");

/** The nested subagent asks to run a command. */
const DRY_RUN_REQUEST = buildRequest("req-dry-run", DRY_RUN.id, "./scripts/deploy.sh --dry-run");

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

/**
 * Builds a transcript of one turn that opens with the user message `brief`,
 * numbered from 0. Each of `steeredTexts` follows it as a message steered
 * into the turn.
 */
const buildBriefTurn = (brief: string, ...steeredTexts: string[]): TranscriptRow[] =>
  [
    { _tag: "turn.started", turnId: "s1" },
    ...[brief, ...steeredTexts].flatMap((text, index) => {
      const itemId = `u${String(index + 1)}`;
      const detail = index === 0 ? { text } : { text, steered: true };
      return [
        { _tag: "item.started", turnId: "s1", itemId, kind: "user_message", detail },
        {
          _tag: "item.completed",
          turnId: "s1",
          itemId,
          kind: "user_message",
          status: "completed",
          detail,
        },
      ];
    }),
  ].map((event, position) => {
    const at = "2026-09-08T10:00:00.000Z";
    return {
      position,
      at,
      event: { ...event, eventId: `e${String(position)}`, sessionId: SESSION_ID, at },
    } as TranscriptRow;
  });

const openApp = async (
  state: ControllerState,
  path = `/threads/${SESSION_ID}`,
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(
    buildController(state, {
      // A subagent's transcript is its brief; the session's own is empty.
      [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: (call: Call) => ({
        body: { items: call.search.includes("subagentId=") ? buildBriefTurn(BRIEF) : [] },
      }),
      ...extra,
    }),
  );
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

describe("Request dock: an answer on its way", () => {
  it("keeps an answered Request locked when the user pages away and back before the controller closes it", async () => {
    const user = userEvent.setup();
    const state: ControllerState = {
      session: buildSession({ status: "busy", openRequests: [DRY_RUN_REQUEST, MAIN_REQUEST] }),
      subagents: [PLAN, DRY_RUN],
    };
    const { api } = await openApp(state, undefined, {
      [`POST /api/v1/sessions/${SESSION_ID}/respond-to-approval-request`]: () => ({
        body: state.session,
      }),
    });

    await user.click(await findAnswer(DRY_RUN_REQUEST, "allow"));
    await waitFor(() => {
      expect(api.calls.some((call) => call.path.endsWith("/respond-to-approval-request"))).toBe(
        true,
      );
    });
    await user.click(screen.getByRole("button", { name: "Next Request" }));
    await screen.findByText("stripe listen");
    expect((await findAnswer(MAIN_REQUEST, "allow")).hasAttribute("disabled")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Previous Request" }));

    await screen.findByText("./scripts/deploy.sh --dry-run");
    expect((await findAnswer(DRY_RUN_REQUEST, "allow")).hasAttribute("disabled")).toBe(true);
  });

  it("keeps a child's answered Request locked on the child's page before the controller closes it", async () => {
    const user = userEvent.setup();
    const state: ControllerState = {
      session: buildSession({ status: "busy", openRequests: [DRY_RUN_REQUEST] }),
      subagents: [PLAN, DRY_RUN],
    };
    const { api, router } = await openApp(state, undefined, {
      [`POST /api/v1/sessions/${SESSION_ID}/respond-to-approval-request`]: () => ({
        body: state.session,
      }),
    });

    await user.click(await findAnswer(DRY_RUN_REQUEST, "allow"));
    await waitFor(() => {
      expect(api.calls.some((call) => call.path.endsWith("/respond-to-approval-request"))).toBe(
        true,
      );
    });
    await user.click(screen.getByRole("link", { name: "Open subagent" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}/subagents/${DRY_RUN.id}`);
    });
    await screen.findByText("Waiting on you");
    expect((await findAnswer(DRY_RUN_REQUEST, "allow")).hasAttribute("disabled")).toBe(true);
  });
});

describe("Request dock: a half-answered question", () => {
  it("keeps the typed answer and the shown question when the user pages away and back", async () => {
    const user = userEvent.setup();
    const twoQuestions: SessionRequest = {
      ...PLAN_QUESTION,
      detail: {
        questions: [
          ...PLAN_QUESTION.detail.questions,
          {
            question: "Which day should it roll out?",
            header: "Day",
            options: [{ label: "Monday", description: "start of the week" }],
            multiSelect: false,
          },
        ],
      },
    };
    const state: ControllerState = {
      session: buildSession({ status: "busy", openRequests: [twoQuestions, MAIN_REQUEST] }),
      subagents: [PLAN],
    };
    const { api } = await openApp(state, undefined, {
      [`POST /api/v1/sessions/${SESSION_ID}/respond-to-question`]: () => ({ body: state.session }),
    });

    await user.type(await screen.findByLabelText("Your own answer"), "An hour at night");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Which day should it roll out?");
    await user.type(screen.getByLabelText("Your own answer"), "Sun");
    await user.click(screen.getByRole("button", { name: "Next Request" }));
    await screen.findByText("stripe listen");
    await user.click(screen.getByRole("button", { name: "Previous Request" }));

    await screen.findByText("Which day should it roll out?");
    expect(screen.getByText("Question 2 of 2")).toBeDefined();
    expect(screen.getByLabelText("Your own answer")).toHaveProperty("value", "Sun");
    // The first question's answer was kept too.
    await user.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => {
      expect(
        api.calls.find((call) => call.path.endsWith("/respond-to-question"))?.body,
      ).toMatchObject({ answers: { Downtime: "An hour at night", Day: "Sun" } });
    });
  });
});

describe("Request dock: a subagent the cached list does not hold yet", () => {
  it("opens the page of a subagent whose Request docked before its record was read", async () => {
    const user = userEvent.setup();
    const state: ControllerState = {
      session: buildSession({ status: "idle", openRequests: [DRY_RUN_REQUEST] }),
      subagents: [PLAN],
    };
    const { router } = await openApp(state);
    await screen.findByText("./scripts/deploy.sh --dry-run");
    // The subagent has started since the list was read, and no live nudge
    // has refetched the list yet.
    state.subagents = [PLAN, DRY_RUN];

    await user.click(screen.getByRole("link", { name: "Open subagent" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}/subagents/${DRY_RUN.id}`);
    });
    await screen.findByText("Waiting on you");
    expect(screen.queryByText("This thread has no subagent with this id.")).toBeNull();
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
      endedAt: "2026-09-08T10:02:54.000Z",
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
    expect(stop.getAttribute("title")).toBeNull();
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
    const ended = { ...DRY_RUN, status, endedAt: "2026-09-08T10:02:20.000Z" };
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

  it("leaves out only the brief's own message, so a message steered into the first turn still shows", async () => {
    const steered = "Also check the rollback path";
    await openApp(
      { session: buildSession({ status: "busy" }), subagents: [PLAN, DRY_RUN] },
      `/threads/${SESSION_ID}/subagents/${PLAN.id}`,
      {
        [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: () => ({
          body: { items: buildBriefTurn(BRIEF, steered) },
        }),
      },
    );

    await screen.findByRole("button", { name: BRIEF });
    // The brief shows once, in its card, and the steered message keeps its bubble.
    expect(screen.getAllByText(BRIEF)).toHaveLength(1);
    expect(screen.getByText(steered)).toBeDefined();
    expect(screen.getByText("steered")).toBeDefined();
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
