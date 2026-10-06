/**
 * Tests the thread's side pane as the app mounts it beside the open page:
 * closed until opened, kept per thread across the thread's pages, its
 * Subagents surface with each subagent's face, row and Stop, its drag and
 * keyboard resize, and durations that stand still while the window is hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { togglePane } from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_INSTANCE,
  FIXTURE_SUBAGENT,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
} from "../../../../../app/testing";
import {
  forgetSidePaneLayouts,
  useSidePaneLayout,
} from "../../../../../screens/subagents/use-side-pane";

/** A subagent the fixture subagent started, still running. */
const NESTED_SUBAGENT: Subagent = {
  id: "agent-2",
  sessionId: FIXTURE_SUBAGENT.sessionId,
  parentSubagentId: FIXTURE_SUBAGENT.id,
  description: "Read the retry helper",
  agentType: "Explore",
  status: "running",
  toolCalls: 0,
  startedAt: "2026-09-10T09:04:00.000Z",
};

/** A subagent that finished before the test starts. */
const FINISHED_SUBAGENT: Subagent = {
  id: "agent-3",
  sessionId: FIXTURE_SUBAGENT.sessionId,
  description: "List the webhook tests",
  agentType: "Explore",
  status: "completed",
  toolCalls: 2,
  result: "Twelve tests under test/webhooks.",
  startedAt: "2026-09-10T09:03:00.000Z",
  endedAt: "2026-09-10T09:03:30.000Z",
};

const THREAD = {
  ...THREAD_FIXTURES.delegating,
  subagents: [FINISHED_SUBAGENT, FIXTURE_SUBAGENT, NESTED_SUBAGENT],
};
const SESSION_ID = THREAD.session.id;
const INTERRUPT_PATH = `/api/v1/sessions/${SESSION_ID}/interrupt`;
const WIDTH_KEY = "hercule.side-pane.width";

/** The width of the split the two panes share, and so the right edge of the side pane. */
const SPLIT_WIDTH = 1400;

/** The callback of each element the fake IntersectionObserver watches. */
const intersectionCallbacks = new Map<Element, IntersectionObserverCallback>();

/**
 * Stands in for IntersectionObserver, which jsdom lacks. It reports each
 * element on screen as soon as it is watched, as a browser does for a row
 * in view, until `reportOnScreen` says otherwise.
 */
class FakeIntersectionObserver {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element): void {
    intersectionCallbacks.set(element, this.callback);
    // The row watches from an effect, which already runs inside `act`.
    this.callback([buildEntry(element, true)], this as unknown as IntersectionObserver);
  }
  unobserve(element: Element): void {
    intersectionCallbacks.delete(element);
  }
  disconnect(): void {
    intersectionCallbacks.clear();
  }
}

/** Builds the part of an IntersectionObserver entry the surface reads. */
const buildEntry = (element: Element, onScreen: boolean): IntersectionObserverEntry =>
  ({ target: element, isIntersecting: onScreen }) as IntersectionObserverEntry;

/** Reports `element` inside or outside the visible part of its scroller, as a scroll would. */
const reportOnScreen = (element: Element, onScreen: boolean): void => {
  act(() => {
    intersectionCallbacks.get(element)?.(
      [buildEntry(element, onScreen)],
      {} as IntersectionObserver,
    );
  });
};

beforeEach(() => {
  stubElementSize(800, 800);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  // jsdom lays nothing out, so the split and the pane measure what a
  // 1400px wide main area with the default 420px pane would.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const width = this.classList.contains("side-pane") ? 420 : SPLIT_WIDTH;
    return {
      x: SPLIT_WIDTH - width,
      y: 0,
      width,
      height: 800,
      top: 0,
      left: SPLIT_WIDTH - width,
      right: SPLIT_WIDTH,
      bottom: 800,
      toJSON: () => ({}),
    };
  });
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = () => {};
});

afterEach(() => {
  forgetSidePaneLayouts();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  intersectionCallbacks.clear();
  setVisibility("visible");
});

/** Starts the app signed in at `path`, with the delegating thread's reads and its interrupt. */
const openApp = async (path: string) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, providers: [FIXTURE_INSTANCE] }),
    ...buildThreadHandlers(THREAD),
    ...buildThreadHandlers(THREAD_FIXTURES.failed),
    [`POST ${INTERRUPT_PATH}`]: { body: THREAD.session },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path,
    },
  );
  return { ...app, calls };
};

/** Opens the side pane of the delegating thread, as the header's toggle does. */
const openPane = (): void => {
  const { result } = renderHook(() => useSidePaneLayout(SESSION_ID));
  act(() => {
    result.current.changeLayout(togglePane);
  });
};

/** Returns the side pane, once its lazy chunk has loaded. */
const findPane = (): Promise<HTMLElement> =>
  screen.findByRole("complementary", { name: "Side pane" });

/** Returns the row of the subagent named `name`. */
const findRow = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole("link", { name })).closest<HTMLElement>(".subagent-row")!;

describe("the thread's side pane", () => {
  it("starts closed, and opens on the Subagents surface with a face per subagent", async () => {
    await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();

    openPane();
    const pane = await findPane();
    expect(within(pane).getByRole("tab", { name: "Subagents" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const panel = within(pane).getByRole("tabpanel", { name: "Subagents" });
    const rows = [...panel.querySelectorAll(".subagent-row")];
    expect(rows.map((row) => row.querySelector(".subagent-row-name")?.textContent)).toEqual([
      "List the webhook tests",
      "Find the flaky webhook test",
      "Read the retry helper",
    ]);
    // Every row shows its face, and no face in the pane moves.
    expect(rows.every((row) => row.querySelector(":scope > .cr") !== null)).toBe(true);
    expect(pane.querySelector(".cr--animated")).toBeNull();
    // The subagent the fixture subagent started sits under it.
    expect(rows[2]!.closest("ul")?.classList.contains("subagents-tree--nested")).toBe(true);

    await userEvent.click(within(pane).getByRole("button", { name: "Close the side pane" }));
    expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();
  });

  it("keeps the layout per thread across the thread's pages", async () => {
    const { router } = await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    await findPane();

    await act(() =>
      router.navigate({
        to: "/threads/$sessionId/subagents/$subagentId",
        params: { sessionId: SESSION_ID, subagentId: FIXTURE_SUBAGENT.id },
      }),
    );
    await screen.findByText("Find which webhook test fails, and why.");
    expect(await findPane()).toBeTruthy();

    const otherId = THREAD_FIXTURES.failed.session.id;
    await act(() => router.navigate({ to: "/threads/$sessionId", params: { sessionId: otherId } }));
    await screen.findByText("Sketch the pricing page: three tiers, monthly and yearly.");
    expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();

    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: SESSION_ID } }),
    );
    expect(await findPane()).toBeTruthy();
  });

  it("opens a subagent's page from its row, and marks that row current", async () => {
    const { router } = await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    await findPane();

    await userEvent.click(await screen.findByRole("link", { name: "Find the flaky webhook test" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/threads/${SESSION_ID}/subagents/${FIXTURE_SUBAGENT.id}`,
      );
    });
    const link = await screen.findByRole("link", { name: "Find the flaky webhook test" });
    await waitFor(() => {
      expect(link.getAttribute("aria-current")).toBe("page");
    });
    expect(link.closest(".subagent-row")?.classList.contains("is-on")).toBe(true);
  });

  it("stops one subagent from its row, and every agent from Stop all", async () => {
    const { calls } = await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    await findPane();
    const readInterrupts = () =>
      calls.filter((call) => call.method === "POST" && call.path === INTERRUPT_PATH);

    // A finished subagent has nothing to stop.
    expect(within(await findRow("List the webhook tests")).queryByRole("button")).toBeNull();
    const row = await findRow("Find the flaky webhook test");
    // The row's Stop takes clicks only while the pointer is over the row,
    // which jsdom cannot show, so the click is fired on it directly.
    fireEvent.click(within(row).getByRole("button", { name: /^Stop/ }));
    await waitFor(() => {
      expect(readInterrupts().map((call) => call.body)).toEqual([
        { subagentId: FIXTURE_SUBAGENT.id },
      ]);
    });

    await userEvent.click(screen.getByRole("button", { name: "Stop all" }));
    await waitFor(() => {
      expect(readInterrupts().map((call) => call.body)).toEqual([
        { subagentId: FIXTURE_SUBAGENT.id },
        {},
      ]);
    });
  });

  it("resizes by drag within the minimums, and stores the width only when the drag ends", async () => {
    await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    const pane = await findPane();
    const handle = within(pane).getByRole("separator", { name: "Resize the side pane" });
    const readWidthVariable = () => pane.style.getPropertyValue("--side-pane-width");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: SPLIT_WIDTH - 420 });
    // Dragged right past the side pane's minimum, it stops at 300px.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: SPLIT_WIDTH - 100 });
    expect(readWidthVariable()).toBe("300px");
    // Dragged left past the main pane's minimum, it stops 520px short of the split's width.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(readWidthVariable()).toBe(`${String(SPLIT_WIDTH - 520)}px`);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: SPLIT_WIDTH - 500 });
    expect(readWidthVariable()).toBe("500px");
    expect(handle.getAttribute("aria-valuenow")).toBe("500");
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: SPLIT_WIDTH - 500 });
    expect(localStorage.getItem(WIDTH_KEY)).toBe("500");
    expect(readWidthVariable()).toBe("500px");

    // A click on the edge that never moves stores nothing.
    localStorage.removeItem(WIDTH_KEY);
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: SPLIT_WIDTH - 500 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: SPLIT_WIDTH - 500 });
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
  });

  it("resizes from the keyboard once its edge has focus", async () => {
    await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    const pane = await findPane();
    const handle = within(pane).getByRole("separator", { name: "Resize the side pane" });

    // The measured pane is 420px wide; the left arrow widens it.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(localStorage.getItem(WIDTH_KEY)).toBe("436");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(localStorage.getItem(WIDTH_KEY)).toBe("404");
  });

  it("counts a running subagent's duration, and stops counting while the window is hidden", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T09:05:00.000Z"), toFake: ["Date"] });
    await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    await findPane();
    const readDuration = async (name: string) =>
      (await findRow(name)).querySelector(".subagent-row-end")?.textContent;

    expect(await readDuration("Find the flaky webhook test")).toBe("working ·1m 20s");
    expect(await readDuration("List the webhook tests")).toBe("done ·30s");

    // Only `Date` is faked, so the age clock's one timer runs in real time
    // and reads the moved clock when it fires.
    vi.setSystemTime(new Date("2026-09-10T09:05:10.000Z"));
    await waitFor(
      async () => {
        expect(await readDuration("Find the flaky webhook test")).toBe("working ·1m 30s");
      },
      { timeout: 2_000 },
    );

    setVisibility("hidden");
    vi.setSystemTime(new Date("2026-09-10T09:05:40.000Z"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_200)));
    expect(await readDuration("Find the flaky webhook test")).toBe("working ·1m 30s");

    // Shown again, the duration catches up at once. An ended one never moves.
    setVisibility("visible");
    expect(await readDuration("Find the flaky webhook test")).toBe("working ·2m 0s");
    expect(await readDuration("List the webhook tests")).toBe("done ·30s");
  });

  it("stops counting a running subagent's duration while its row is scrolled out of view", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T09:05:00.000Z"), toFake: ["Date"] });
    await openApp(`/threads/${SESSION_ID}`);
    await screen.findByRole("textbox");
    openPane();
    const pane = await findPane();
    const readDuration = (subagentId: string) =>
      pane.querySelector(`[data-subagent-duration="${subagentId}"]`)?.textContent;
    expect(readDuration(FIXTURE_SUBAGENT.id)).toBe("1m 20s");
    expect(readDuration(NESTED_SUBAGENT.id)).toBe("1m 0s");

    reportOnScreen(await findRow("Find the flaky webhook test"), false);
    vi.setSystemTime(new Date("2026-09-10T09:05:10.000Z"));
    // The row still on screen shows the clock fired; the one off screen kept its text.
    await waitFor(
      () => {
        expect(readDuration(NESTED_SUBAGENT.id)).toBe("1m 10s");
      },
      { timeout: 2_000 },
    );
    expect(readDuration(FIXTURE_SUBAGENT.id)).toBe("1m 20s");

    // Back in view, it catches up at once.
    reportOnScreen(await findRow("Find the flaky webhook test"), true);
    expect(readDuration(FIXTURE_SUBAGENT.id)).toBe("1m 30s");
  });
});
