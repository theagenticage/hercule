/**
 * Tests the sidebar's failed-run dot as the signed-in app renders it: the dot
 * on the Overview row in the Hercule face and on the Hercule segment in the
 * Threads face, what each opens, that the word on the segment still only
 * changes the face, and that the dot follows the controller's answer after a
 * push and after a reconnect.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  stubIntersectionObserver,
} from "../app/testing";

const FAILED_CARD_ID = "01a06d02-7e00-7000-8000-000000000002";
const QUIET_CARD_ID = "01a06d02-7e00-7000-8000-000000000003";

const BOARD = buildBoard(
  buildCard(QUIET_CARD_ID, { title: "Order history hides cancelled items" }),
  buildCard(FAILED_CARD_ID, {
    title: "Cache delivery slot lookups",
    stage: "in-review",
    failure: {
      runId: "01a06d02-7e00-7000-8000-000000000902",
      workflowName: "Review PR",
      cause: "the branch changed mid-run",
    },
  }),
);

beforeEach(() => {
  stubElementSize(272, 800);
  stubIntersectionObserver();
});

afterEach(() => {
  localStorage.clear();
});

/**
 * Starts the app signed in at `path`. `hasFailedRun` is a function so a test
 * can change what the controller answers to the sidebar's read.
 */
const startApp = async (hasFailedRun: () => boolean, path = "/") => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/tasks/attention": () => ({ body: { anyFailure: hasFailedRun() } }),
    "GET /api/v1/tasks/board": { body: BOARD },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  await screen.findByRole("tablist", { name: "Sidebar" });
  return { calls, ...app };
};

const getSegment = (name: "Threads" | "Hercule"): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Sidebar" })).getByRole("tab", { name });

/** Returns the Overview row, once the Hercule face is showing. */
const getOverviewRow = (): HTMLElement =>
  within(screen.getByRole("navigation", { name: "Hercule" })).getByRole("link", {
    name: /^Overview/,
  });

const SEGMENT_DOT = { name: "A run failed. Open Work filtered to Failed." };

describe("the failed-run dot on the Overview row", () => {
  it("shows no dot while no run has failed", async () => {
    await startApp(() => false, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await userEvent.click(getSegment("Hercule"));

    expect(getOverviewRow().querySelector(".nav-dot")).toBeNull();
    expect(getOverviewRow().getAttribute("aria-label")).toBeNull();
  });

  it("shows a dot with no number, named for a screen reader, while a run has failed", async () => {
    await startApp(() => true, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await userEvent.click(getSegment("Hercule"));

    const row = getOverviewRow();
    expect(row.querySelector(".nav-dot")?.textContent).toBe("");
    expect(row.getAttribute("aria-label")).toBe("Overview, a run failed");
    expect(row.textContent).toBe("Overview");
  });

  it("opens Work with only the failed cards, and takes the request out of the address", async () => {
    const { router } = await startApp(() => true, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await userEvent.click(getSegment("Hercule"));

    await userEvent.click(getOverviewRow());

    expect(
      await screen.findByRole("button", { name: /^Cache delivery slot lookups/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove filter Failed" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Order history hides cancelled items/ }),
    ).toBeNull();
    expect(router.state.location.pathname).toBe("/work");
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
  });

  it("opens Work on what failed even when the Office was the view used last", async () => {
    localStorage.setItem(`overview-view:${CONTROLLER_URL}`, "office");
    const { router } = await startApp(() => true, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await userEvent.click(getSegment("Hercule"));

    await userEvent.click(getOverviewRow());

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/work");
    });
    expect(await screen.findByRole("button", { name: "Remove filter Failed" })).toBeTruthy();
  });

  it("opens the Overview as before while nothing has failed", async () => {
    const { router } = await startApp(() => false, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await userEvent.click(getSegment("Hercule"));

    await userEvent.click(getOverviewRow());

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/work");
    });
    expect(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove filter Failed" })).toBeNull();
  });
});

describe("the failed-run dot on the Hercule segment", () => {
  it("shows no dot while no run has failed", async () => {
    await startApp(() => false, `/threads/${FIXTURE_THREAD_IDS.flaky}`);

    expect(screen.queryByRole("button", SEGMENT_DOT)).toBeNull();
  });

  it("is a button of its own beside the tab, not inside it, and only on the Threads face", async () => {
    await startApp(() => true, `/threads/${FIXTURE_THREAD_IDS.flaky}`);

    const dot = await screen.findByRole("button", SEGMENT_DOT);
    expect(getSegment("Hercule").contains(dot)).toBe(false);
    expect(
      within(screen.getByRole("tablist", { name: "Sidebar" })).queryByRole("button"),
    ).toBeNull();

    await userEvent.click(getSegment("Hercule"));

    expect(screen.queryByRole("button", SEGMENT_DOT)).toBeNull();
    expect(getOverviewRow().querySelector(".nav-dot")).not.toBeNull();
  });

  it("changes only the face when the word is clicked", async () => {
    const { router } = await startApp(() => true, `/threads/${FIXTURE_THREAD_IDS.flaky}`);

    await userEvent.click(getSegment("Hercule"));

    expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    expect(getSegment("Hercule").getAttribute("aria-selected")).toBe("true");
  });

  it("opens Work on what failed when the dot is clicked", async () => {
    const { router } = await startApp(() => true, `/threads/${FIXTURE_THREAD_IDS.flaky}`);

    await userEvent.click(await screen.findByRole("button", SEGMENT_DOT));

    expect(await screen.findByRole("button", { name: "Remove filter Failed" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/work");
    // Work belongs to the Hercule face, which the sidebar follows to.
    expect(getOverviewRow().getAttribute("aria-current")).toBe("page");
  });
});

describe("the failed-run dot follows the controller", () => {
  it("appears after a plain task push and goes after the next", async () => {
    let hasFailedRun = false;
    const { live } = await startApp(() => hasFailedRun, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await live.waitForFirstPushes();
    expect(screen.queryByRole("button", SEGMENT_DOT)).toBeNull();

    hasFailedRun = true;
    live.pushInvalidation("task", [FAILED_CARD_ID]);
    expect(await screen.findByRole("button", SEGMENT_DOT)).toBeTruthy();

    hasFailedRun = false;
    live.pushInvalidation("task", [FAILED_CARD_ID]);
    await waitFor(() => {
      expect(screen.queryByRole("button", SEGMENT_DOT)).toBeNull();
    });
  });

  it("catches up after a reconnect, when the run failed while the connection was down", async () => {
    let hasFailedRun = false;
    const { live } = await startApp(() => hasFailedRun, `/threads/${FIXTURE_THREAD_IDS.flaky}`);
    await live.waitForFirstPushes();

    hasFailedRun = true;
    live.drop();

    expect(await screen.findByRole("button", SEGMENT_DOT)).toBeTruthy();
  });
});
