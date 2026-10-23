/**
 * Tests the thread header against the stubbed controller: the tabs of the
 * thread's workspace, how each tab ends, the link to a new thread in the
 * workspace, the two buttons that are drawn but do nothing yet, the crumbs of
 * a run's step session, and the side pane's toggle, on the thread's page and
 * on a subagent's page.
 */
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import type { Run, Session, Workflow } from "@hercule/contract";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import {
  buildErrorBody,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  FIXTURE_SUBAGENT,
  FIXTURE_THREAD_IDS,
  neverAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type Call,
  type Handler,
} from "../../app/testing";
import { sessionQuery } from "../../app/queries";
import { forgetSidePaneLayouts } from "../subagents/use-side-pane";
import { renderThreadPart } from "./testing";
import { ThreadHeader } from "./thread-header";

/** Renders the header of the thread `sessionId`, from its session's read, as the thread's page does. */
function HeaderOfThread({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const session = useSuspenseQuery(sessionQuery(controller.client, sessionId)).data;
  return <ThreadHeader session={session} />;
}

afterEach(() => {
  vi.useRealTimers();
  forgetSidePaneLayouts();
});

/** Returns the header's first pill: the project and the workspace's tabs. */
const readTabStrip = (): HTMLElement =>
  screen.getByRole("navigation", { name: "Threads in this workspace" });

/** Returns the accessible name of every link in the tab strip, in order. */
const readLinkNames = (): readonly (string | null)[] =>
  within(readTabStrip())
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label") ?? link.getAttribute("title"));

describe("the thread header", () => {
  it("draws a tab per thread of the workspace, in the workspace's order, with the open one selected", async () => {
    await renderThreadPart(HeaderOfThread, { thread: THREAD_FIXTURES.waiting });

    expect(readLinkNames()).toEqual([
      "Fix flaky webhook tests, working",
      "Write the retry runbook, waiting on you",
      "New thread in this workspace",
    ]);
    const open = within(readTabStrip()).getByRole("link", {
      name: "Write the retry runbook, waiting on you",
    });
    const other = within(readTabStrip()).getByRole("link", {
      name: "Fix flaky webhook tests, working",
    });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.classList.contains("is-on")).toBe(true);
    expect(other.getAttribute("aria-current")).toBeNull();
    expect(other.getAttribute("href")).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    // A working or waiting thread ends in its mark, which the name already
    // says, so the tab holds only its title and describes nothing.
    for (const tab of [open, other]) {
      expect(tab.querySelector("svg")).not.toBeNull();
      expect(tab.querySelector("small")).toBeNull();
      expect(tab.getAttribute("aria-describedby")).toBeNull();
    }
    expect(within(readTabStrip()).getByText("webshop")).toBeTruthy();
  });

  it("draws the syncing marker in the free space after the tabs, empty while nothing syncs", async () => {
    await renderThreadPart(HeaderOfThread, { thread: THREAD_FIXTURES.waiting });

    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("draws a thread alone in its workspace as one tab, ending in the age it was last active", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T09:25:00.000Z"), toFake: ["Date"] });
    await renderThreadPart(HeaderOfThread, { thread: THREAD_FIXTURES.finished });

    expect(readLinkNames()).toEqual(["Bump the Bun pin, idle", "New thread in this workspace"]);
    const tab = within(readTabStrip()).getByRole("link", {
      name: "Bump the Bun pin, idle",
      description: "22 minutes ago",
    });
    expect(tab.querySelector("small")?.textContent).toBe("22m");
    expect(tab.querySelector("svg")).not.toBeNull();
  });

  it("labels a thread with a role by it, names the tab starting with the role, and keeps the title as its tooltip", async () => {
    const { finished } = THREAD_FIXTURES;
    await renderThreadPart(HeaderOfThread, {
      thread: { ...finished, session: { ...finished.session, role: "review" } },
    });

    const tab = within(readTabStrip()).getByRole("link", {
      name: "review, Bump the Bun pin, idle",
    });
    const text = tab.querySelector(".ptab-title");
    expect(text?.textContent).toBe("review");
    expect(text?.getAttribute("title")).toBe("Bump the Bun pin");
  });

  it("numbers a role among every session of the workspace, an exited one included, as the sidebar does", async () => {
    const { waiting } = THREAD_FIXTURES;
    const open = { ...waiting.session, role: "review" };
    // The workspace no longer lists it, so it is no tab, yet it was the first "review".
    const earlier = buildSession({
      ...waiting.session,
      id: "01a06d02-7400-7000-8000-0000000000ff",
      title: "Review the webhook change",
      role: "review",
      status: "exited",
      createdAt: "2026-09-10T09:00:00.000Z",
    });
    await renderThreadPart(HeaderOfThread, {
      thread: { ...waiting, session: open },
      handlers: buildSidebarHandlers({
        ...SIDEBAR_FIXTURE,
        threads: [
          earlier,
          ...SIDEBAR_FIXTURE.threads.map((each) => (each.id === open.id ? open : each)),
        ],
      }),
    });

    expect(readLinkNames()).toEqual([
      "Fix flaky webhook tests, working",
      "review 2, Write the retry runbook, waiting on you",
      "New thread in this workspace",
    ]);
  });

  it("ends a tab in a word when the thread's sidebar row would", async () => {
    const { finished } = THREAD_FIXTURES;
    await renderThreadPart(HeaderOfThread, {
      thread: { ...finished, session: { ...finished.session, status: "queued" } },
    });

    const tab = within(readTabStrip()).getByRole("link", {
      name: "Bump the Bun pin, working",
      description: "queued",
    });
    expect(tab.querySelector("small")?.textContent).toBe("queued");
  });

  it("links + to a new thread in the thread's workspace", async () => {
    const { session } = THREAD_FIXTURES.finished;
    await renderThreadPart(HeaderOfThread, { thread: THREAD_FIXTURES.finished });

    const primary = SIDEBAR_FIXTURE.workspaces[0]!;
    expect(session.workspaceId).toBe(primary.id);
    expect(
      within(readTabStrip())
        .getByRole("link", { name: "New thread in this workspace" })
        .getAttribute("href"),
    ).toBe(`/?project=${session.projectId!}&workspace=${primary.id}`);
  });

  it("draws no + while the thread's workspace is not ready, because a new thread could not join it", async () => {
    const [primary, ...others] = SIDEBAR_FIXTURE.workspaces;
    await renderThreadPart(HeaderOfThread, {
      thread: THREAD_FIXTURES.finished,
      handlers: {
        "GET /api/v1/workspaces": {
          body: { items: [{ ...primary!, status: "provisioning" }, ...others] },
        },
      },
    });

    expect(readLinkNames()).toEqual(["Bump the Bun pin, idle"]);
  });

  it("draws a thread in no project and no workspace with its one tab and no +", async () => {
    await renderThreadPart(HeaderOfThread, { thread: THREAD_FIXTURES.failed });

    expect(readLinkNames()).toEqual(["Sketch the pricing page, idle"]);
    expect(within(readTabStrip()).getByText("No project")).toBeTruthy();
  });

  it("draws Open in editor and More as disabled buttons that do nothing", async () => {
    const user = userEvent.setup();
    const { calls } = await renderThreadPart(HeaderOfThread, { thread: THREAD_FIXTURES.finished });
    const sent = calls.length;

    for (const name of ["Open in editor", "More"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await user.click(button);
    }
    expect(calls).toHaveLength(sent);
    expect(readLinkNames()).toEqual(["Bump the Bun pin, idle", "New thread in this workspace"]);
  });
});

describe("a step session's header", () => {
  const AT = "2026-10-11T09:30:00.000Z";
  const RUN_ID = "01a06d02-7900-7000-8000-0000000000a1";
  const WORKFLOW_ID = "01a06d02-7800-7000-8000-0000000000a1";
  const WORKSPACE_ID = "01a06d02-7d00-7000-8000-0000000000a1";
  const PLAN_ID = "01a06d02-7a00-7000-8000-0000000000a1";
  const IMPLEMENT_ID = "01a06d02-7a00-7000-8000-0000000000a2";

  const AGENT_ID = "01a06d02-7b00-7000-8000-0000000000a1";
  // The ids the contract accepts, taken from a fixture thread on the fixture's runner.
  const { runnerId, permissionProfileId, instanceId } = THREAD_FIXTURES.finished.session;

  /** The run's first step session, which has finished its turn. */
  const PLAN_SESSION: Session = buildSession({
    runnerId,
    permissionProfileId,
    instanceId,
    id: PLAN_ID,
    kind: "run",
    title: "Ticket to pull request · plan",
    runId: RUN_ID,
    stepId: "plan",
    workspaceId: WORKSPACE_ID,
  });

  /** The step session whose header is drawn, at work. */
  const IMPLEMENT_SESSION: Session = buildSession({
    runnerId,
    permissionProfileId,
    instanceId,
    id: IMPLEMENT_ID,
    kind: "run",
    title: "Ticket to pull request · implement",
    status: "busy",
    runId: RUN_ID,
    stepId: "implement",
    workspaceId: WORKSPACE_ID,
  });

  const RUN: Run = {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    plan: {
      name: "Ticket to pull request",
      steps: [
        { id: "plan", kind: "agent", agent: AGENT_ID, prompt: "Plan." },
        { id: "implement", kind: "agent", agent: AGENT_ID, prompt: "Build." },
      ],
      edges: [{ from: "plan", to: "implement" }],
    },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    workspaceId: WORKSPACE_ID,
    subscriptions: [],
    createdAt: AT,
    status: "running",
    startedAt: AT,
    steps: [
      {
        stepId: "plan",
        iteration: 1,
        status: "completed",
        startedAt: AT,
        finishedAt: AT,
        output: {},
      },
      {
        stepId: "implement",
        iteration: 1,
        status: "running",
        startedAt: AT,
        sessionId: IMPLEMENT_ID,
      },
    ],
    edgeTraversals: [1],
  };

  const WORKFLOW: Workflow = {
    id: WORKFLOW_ID,
    enabled: true,
    source: "name: Ticket to pull request\n",
    createdAt: AT,
    updatedAt: AT,
  };

  /** The stubbed controller's answers for the run's workspace, its sessions, its run and its workflow. */
  const buildRunHandlers = (
    over: Readonly<Record<string, Handler>> = {},
  ): Readonly<Record<string, Handler>> => {
    const sidebar = buildSidebarHandlers(SIDEBAR_FIXTURE);
    const answerSessions = sidebar["GET /api/v1/sessions"] as (call: Call) => unknown;
    return {
      "GET /api/v1/sessions": (call) =>
        !new URLSearchParams(call.search).getAll("kind").includes("thread")
          ? { body: { items: [PLAN_SESSION, IMPLEMENT_SESSION] } }
          : (answerSessions(call) as { body: unknown }),
      "GET /api/v1/workspaces": {
        body: {
          items: [
            ...SIDEBAR_FIXTURE.workspaces,
            buildWorkspace({
              id: WORKSPACE_ID,
              runnerId,
              kind: "ephemeral",
              sessionIds: [PLAN_ID, IMPLEMENT_ID],
            }),
          ],
        },
      },
      "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
      [`GET /api/v1/runs/${RUN_ID}`]: { body: RUN },
      [`GET /api/v1/workflows/${WORKFLOW_ID}`]: { body: WORKFLOW },
      ...over,
    };
  };

  /** Answers the workspace list with the run's workspace holding `sessionIds`. */
  const holdRunWorkspace = (sessionIds: readonly string[]): Record<string, Handler> => ({
    "GET /api/v1/workspaces": {
      body: {
        items: [
          ...SIDEBAR_FIXTURE.workspaces,
          buildWorkspace({ id: WORKSPACE_ID, runnerId, kind: "ephemeral", sessionIds }),
        ],
      },
    },
  });

  /** Renders the header of the implement step's session. */
  const renderStepHeader = (over?: Readonly<Record<string, Handler>>) => {
    vi.useFakeTimers({ now: new Date("2026-10-11T10:00:00.000Z"), toFake: ["Date"] });
    return renderThreadPart(HeaderOfThread, {
      thread: { ...THREAD_FIXTURES.finished, session: IMPLEMENT_SESSION },
      handlers: buildRunHandlers(over),
    });
  };

  const readStepStrip = (): HTMLElement =>
    screen.getByRole("navigation", { name: "Sessions in this workspace" });

  /** Returns every link of the strip in order, named by its `aria-label` or else its text. */
  const readStepLinkNames = (): readonly (string | null)[] =>
    within(readStepStrip())
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label") ?? link.textContent);

  it("draws Workflows, the run's workflow and the run, then a tab per session of the run's workspace", async () => {
    await renderStepHeader();

    const strip = readStepStrip();
    const workflows = await within(strip).findByRole("link", { name: "Workflows" });
    expect(workflows.getAttribute("href")).toBe("/workflows");
    expect(
      within(strip).getByRole("link", { name: "Ticket to pull request" }).getAttribute("href"),
    ).toBe(`/workflows/${WORKFLOW_ID}`);
    const run = within(strip).getByRole("link", { name: "Run Today 09:30, Running" });
    expect(run.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    // The run's one step is at work, so its mark is drawn.
    expect(run.querySelector("svg")).not.toBeNull();
    expect(within(strip).queryByText("No project")).toBeNull();
    expect(readStepLinkNames()).toEqual([
      "Workflows",
      "Ticket to pull request",
      "Run Today 09:30, Running",
      "Ticket to pull request · plan, idle",
      "Ticket to pull request · implement, working",
    ]);
  });

  it("names the run's link with the run's state, so a finished run does not sound like a live one", async () => {
    const finishedRun: Run = {
      ...RUN,
      status: "completed",
      finishedAt: "2026-10-11T09:40:00.000Z",
      steps: RUN.steps.map((record) => ({
        stepId: record.stepId,
        iteration: 1,
        status: "completed",
        startedAt: AT,
        finishedAt: "2026-10-11T09:40:00.000Z",
        output: {},
      })),
    };
    await renderStepHeader({ [`GET /api/v1/runs/${RUN_ID}`]: { body: finishedRun } });

    expect(
      await within(readStepStrip()).findByRole("link", { name: "Run Today 09:30, Completed" }),
    ).toBeTruthy();
  });

  it("labels each tab with its step's id, and keeps the full title as its tooltip", async () => {
    await renderStepHeader();
    await within(readStepStrip()).findByRole("link", { name: "Workflows" });

    const open = within(readStepStrip()).getByRole("link", {
      name: "Ticket to pull request · implement, working",
    });
    expect(open.textContent).toBe("implement");
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.querySelector(".ptab-title")?.getAttribute("title")).toBe(
      "Ticket to pull request · implement",
    );
    const other = within(readStepStrip()).getByRole("link", {
      name: "Ticket to pull request · plan, idle",
    });
    expect(other.textContent).toContain("plan");
    expect(other.getAttribute("href")).toBe(`/threads/${PLAN_ID}`);
  });

  it("draws no +, because a new thread would not be a session of the run", async () => {
    await renderStepHeader();
    await within(readStepStrip()).findByRole("link", { name: "Workflows" });

    expect(
      within(readStepStrip()).queryByRole("link", { name: "New thread in this workspace" }),
    ).toBeNull();
  });

  it("lists a thread that works in the run's workspace as a tab, labelled with its title", async () => {
    await renderStepHeader(holdRunWorkspace([PLAN_ID, IMPLEMENT_ID, FIXTURE_THREAD_IDS.bunPin]));
    await within(readStepStrip()).findByRole("link", { name: "Workflows" });

    const thread = within(readStepStrip()).getByRole("link", { name: "Bump the Bun pin, idle" });
    expect(thread.textContent).toContain("Bump the Bun pin");
    expect(readStepLinkNames().slice(-3)).toEqual([
      "Ticket to pull request · plan, idle",
      "Ticket to pull request · implement, working",
      "Bump the Bun pin, idle",
    ]);
  });

  it("does not add a step session to the tabs of a thread in the same workspace", async () => {
    const stepInThreadWorkspace: Session = {
      ...IMPLEMENT_SESSION,
      workspaceId: SIDEBAR_FIXTURE.workspaces[1]!.id,
    };
    await renderThreadPart(HeaderOfThread, {
      thread: THREAD_FIXTURES.waiting,
      handlers: {
        ...buildRunHandlers(),
        "GET /api/v1/sessions": (call) =>
          !new URLSearchParams(call.search).getAll("kind").includes("thread")
            ? { body: { items: [stepInThreadWorkspace] } }
            : (
                buildSidebarHandlers(SIDEBAR_FIXTURE)["GET /api/v1/sessions"] as (call: Call) => {
                  body: unknown;
                }
              )(call),
        "GET /api/v1/workspaces": {
          body: {
            items: SIDEBAR_FIXTURE.workspaces.map((workspace, index) =>
              index === 1
                ? { ...workspace, sessionIds: [...workspace.sessionIds, IMPLEMENT_ID] }
                : workspace,
            ),
          },
        },
      },
    });

    expect(readLinkNames()).toEqual([
      "Fix flaky webhook tests, working",
      "Write the retry runbook, waiting on you",
      "New thread in this workspace",
    ]);
  });

  it("opens without waiting on a workflow read that never answers, and still draws the crumbs", async () => {
    await renderStepHeader({ [`GET /api/v1/workflows/${WORKFLOW_ID}`]: neverAnswer });

    const strip = readStepStrip();
    expect(
      await within(strip).findByRole("link", { name: "Run Today 09:30, Running" }),
    ).toBeTruthy();
    expect(within(strip).getByRole("link", { name: "Ticket to pull request" })).toBeTruthy();
  });

  it("names a workflow that was deleted from the run's plan, with no link", async () => {
    await renderStepHeader({
      [`GET /api/v1/workflows/${WORKFLOW_ID}`]: {
        status: 404,
        body: buildErrorBody("not_found", "no such workflow"),
      },
    });

    const strip = readStepStrip();
    await within(strip).findByRole("link", { name: "Workflows" });
    expect(within(strip).queryByRole("link", { name: "Ticket to pull request" })).toBeNull();
    expect(within(strip).getByText("deleted")).toBeTruthy();
    expect(within(strip).getByText("Ticket to pull request", { selector: "span" })).toBeTruthy();
  });

  it("leaves a way back to Workflows when the run is gone, and keeps the tabs", async () => {
    await renderStepHeader({
      [`GET /api/v1/runs/${RUN_ID}`]: {
        status: 404,
        body: buildErrorBody("not_found", "no such run"),
      },
    });

    const strip = readStepStrip();
    await within(strip).findByRole("link", { name: "Workflows" });
    expect(readStepLinkNames()).toEqual([
      "Workflows",
      "Ticket to pull request · plan, idle",
      "Ticket to pull request · implement, working",
    ]);
  });
});

describe("the side pane's toggle", () => {
  // The Office's thread drawer draws no toggle; office-screen.integration.test.tsx checks that.

  /** Starts the app signed in at `path`, with the delegating thread's reads. */
  const openApp = (path: string) => {
    stubElementSize(800, 800);
    stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
      ...buildThreadHandlers(THREAD_FIXTURES.delegating),
    });
    return renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
      path,
    });
  };

  it("shows and hides the thread's side pane, pressed while the pane is open", async () => {
    await openApp(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    const toggle = await screen.findByRole("button", { name: "Side pane" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("Show the side pane");

    await userEvent.click(toggle);

    expect(toggle.title).toBe("Hide the side pane");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.classList.contains("is-on")).toBe(true);
    expect(await screen.findByRole("complementary", { name: "Side pane" })).toBeTruthy();
  });

  it("is drawn on a subagent's page too", async () => {
    await openApp(`/threads/${FIXTURE_THREAD_IDS.flaky}/subagents/${FIXTURE_SUBAGENT.id}`);
    expect(await screen.findByRole("button", { name: "Side pane" })).toBeTruthy();
  });
});
