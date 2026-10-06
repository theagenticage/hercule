/**
 * Tests the thread header against the stubbed controller: the tabs of the
 * thread's workspace, how each tab ends, the link to a new thread in the
 * workspace, the two buttons that are drawn but do nothing yet, the crumb
 * on a subagent's page, and the side pane's toggle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Subagent } from "@hercule/contract";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  FIXTURE_SUBAGENT,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../app/testing";
import { forgetSidePaneLayouts } from "../subagents/use-side-pane";
import { renderThreadPart } from "./testing";
import { ThreadHeader } from "./thread-header";

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
    await renderThreadPart(ThreadHeader, { thread: THREAD_FIXTURES.waiting });

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

  it("draws a thread alone in its workspace as one tab, ending in the age it was last active", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T09:25:00.000Z"), toFake: ["Date"] });
    await renderThreadPart(ThreadHeader, { thread: THREAD_FIXTURES.finished });

    expect(readLinkNames()).toEqual(["Bump the Bun pin, idle", "New thread in this workspace"]);
    const tab = within(readTabStrip()).getByRole("link", {
      name: "Bump the Bun pin, idle",
      description: "22 minutes ago",
    });
    expect(tab.querySelector("small")?.textContent).toBe("22m");
    expect(tab.querySelector("svg")).not.toBeNull();
  });

  it("ends a tab in a word when the thread's sidebar row would", async () => {
    const { finished } = THREAD_FIXTURES;
    await renderThreadPart(ThreadHeader, {
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
    await renderThreadPart(ThreadHeader, { thread: THREAD_FIXTURES.finished });

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
    await renderThreadPart(ThreadHeader, {
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
    await renderThreadPart(ThreadHeader, { thread: THREAD_FIXTURES.failed });

    expect(readLinkNames()).toEqual(["Sketch the pricing page, idle"]);
    expect(within(readTabStrip()).getByText("No project")).toBeTruthy();
  });

  it("draws Open in editor and More as disabled buttons that do nothing", async () => {
    const user = userEvent.setup();
    const { calls } = await renderThreadPart(ThreadHeader, { thread: THREAD_FIXTURES.finished });
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

describe("the header of a subagent's page", () => {
  /** A subagent that `FIXTURE_SUBAGENT` started. */
  const CHILD: Subagent = {
    id: "agent-2",
    sessionId: FIXTURE_THREAD_IDS.flaky,
    parentSubagentId: FIXTURE_SUBAGENT.id,
    description: "Read the retry test",
    status: "running",
    toolCalls: 0,
    startedAt: "2026-09-10T09:04:00.000Z",
  };

  /** Renders the header of the page of the subagent `subagentId` of the delegating thread. */
  const renderSubagentHeader = (subagentId: string) =>
    renderThreadPart(
      ({ sessionId }) => <ThreadHeader sessionId={sessionId} subagentId={subagentId} />,
      { thread: { ...THREAD_FIXTURES.delegating, subagents: [FIXTURE_SUBAGENT, CHILD] } },
    );

  it("draws the crumb from the thread down through the ancestors, each linking to its page", async () => {
    await renderSubagentHeader(CHILD.id);

    const crumbs = screen.getByRole("navigation", { name: "Subagent of" });
    const links = within(crumbs).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Fix flaky webhook tests", `/threads/${FIXTURE_THREAD_IDS.flaky}`],
      [
        "Find the flaky webhook test",
        `/threads/${FIXTURE_THREAD_IDS.flaky}/subagents/${FIXTURE_SUBAGENT.id}`,
      ],
    ]);
    // The subagent itself comes last, not as a link, with its tag.
    const here = crumbs.querySelector(".subagent-crumb-here");
    expect(here?.textContent).toBe("Read the retry testsubagent");
    expect(here?.getAttribute("style")).toMatch(/--hue: var\(--hue-/);
    expect(here?.querySelector("svg")).not.toBeNull();
    // The thread's tabs, Open in editor and More belong to the thread's own page.
    expect(screen.queryByRole("navigation", { name: "Threads in this workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("draws a subagent the thread started with the thread as its only earlier crumb", async () => {
    await renderSubagentHeader(FIXTURE_SUBAGENT.id);

    const crumbs = screen.getByRole("navigation", { name: "Subagent of" });
    expect(
      within(crumbs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Fix flaky webhook tests"]);
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
    const toggle = await screen.findByRole("button", { name: "Show the side pane" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(toggle);

    expect(toggle.getAttribute("aria-label")).toBe("Hide the side pane");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.classList.contains("is-on")).toBe(true);
    expect(await screen.findByRole("complementary", { name: "Side pane" })).toBeTruthy();
  });

  it("is drawn on a subagent's page too", async () => {
    await openApp(`/threads/${FIXTURE_THREAD_IDS.flaky}/subagents/${FIXTURE_SUBAGENT.id}`);
    expect(await screen.findByRole("button", { name: "Show the side pane" })).toBeTruthy();
  });
});
