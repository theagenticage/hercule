/**
 * Tests the last screen through the real router: the screen each launch
 * opens, the fallback when that screen is gone, the screen a sign-in at
 * launch leads to, and the screens stored as the user moves around.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";
import type { Appearance } from "../../ipc/contract";
import {
  buildSidebarHandlers,
  FIXTURE_SUBAGENT,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
} from "./testing";

// The Office's 3D scene needs WebGL, which jsdom does not have.
vi.mock("../office/office-scene", () => ({
  mountOfficeScene: () => ({ setWorld: () => undefined, dispose: () => undefined }),
}));

const thread = THREAD_FIXTURES.finished;
const threadPath = `/threads/${thread.session.id}`;

/** Returns the stored last screen for `controllerUrl`, or `null` when none is stored. */
const readStoredScreen = (controllerUrl = CONTROLLER_URL): string | null =>
  localStorage.getItem(`last-screen:${controllerUrl}`);

/** Stores `path` as the last screen for `controllerUrl`, as an earlier run of the app would. */
const storeScreen = (path: string, controllerUrl = CONTROLLER_URL): void => {
  localStorage.setItem(`last-screen:${controllerUrl}`, path);
};

/**
 * Starts the app with the sidebar fixture and the reads of `threadRecords`,
 * the finished thread unless given, signed in unless `token` is `null`.
 */
const launch = (
  openOn: Appearance["openOn"] = "lastScreen",
  token: string | null = "bearer",
  threadRecords: Parameters<typeof buildThreadHandlers>[0] = thread,
) => {
  stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    ...buildThreadHandlers(threadRecords),
    "POST /api/v1/auth/login": {
      body: { token: "fresh-bearer", expiresAt: "2026-10-29T12:00:00.000Z" },
    },
  });
  return renderApp(
    createFakeBridge({
      controllerUrl: CONTROLLER_URL,
      ...(token === null ? {} : { token }),
      appearance: { ...DEFAULT_APPEARANCE, openOn },
    }),
  );
};

describe("a launch", () => {
  it("opens the last screen stored for this controller", async () => {
    storeScreen(threadPath);
    storeScreen("/office", "http://another.test");
    const { router } = await launch();
    expect(router.state.location.pathname).toBe(threadPath);
  });

  it("opens the thread an older build stored as the last open one", async () => {
    localStorage.setItem(`last-thread:${CONTROLLER_URL}`, thread.session.id);
    const { router } = await launch();
    expect(router.state.location.pathname).toBe(threadPath);
  });

  it("opens a subagent's page stored as the last screen", async () => {
    const path = `/threads/${FIXTURE_SUBAGENT.sessionId}/subagents/${FIXTURE_SUBAGENT.id}`;
    storeScreen(path);
    const { router } = await launch("lastScreen", "bearer", THREAD_FIXTURES.delegating);
    expect(router.state.location.pathname).toBe(path);
  });

  it.each([
    ["a thread", "/threads/01a06d02-7400-7000-8000-0000000000ff", "This thread was not found."],
    [
      "an assistant",
      "/assistants/01a06d02-a000-7000-8000-0000000000ff",
      "This assistant was not found.",
    ],
    [
      "a subagent",
      `${threadPath}/subagents/01a06d02-5000-7000-8000-0000000000ff`,
      "This thread has no subagent with this id.",
    ],
  ])(
    "opens the new-thread screen, and stores it, when the last screen shows %s that is gone",
    async (_, path, notFound) => {
      storeScreen(path);
      const { router } = await launch();
      expect(router.state.location.pathname).toBe("/");
      expect(screen.queryByText(notFound)).toBeNull();
      expect(readStoredScreen()).toBe("/");
    },
  );

  it.each([
    ["a screen this build does not have", "/intake"],
    ["Settings", "/settings/appearance"],
    ["sign-in", "/login"],
    ["a path past a screen's own", "/office/old"],
    ["a path that does not start with a slash", "office"],
    ["a relative path", "../settings"],
    ["an empty path", ""],
    ["a thread whose id is corrupted", "/threads/not-an-id"],
    ["an assistant whose id is corrupted", "/assistants/not-an-id"],
    ["a subagent whose id is corrupted", `${threadPath}/subagents/agent:1`],
  ])("opens the new-thread screen when the stored path leads to %s", async (_, path) => {
    storeScreen(path);
    const { router } = await launch();
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens the Office when Open on is The office, and keeps the stored screen", async () => {
    storeScreen(threadPath);
    const { router } = await launch("office");
    expect(router.state.location.pathname).toBe("/office");
    expect(readStoredScreen()).toBe(threadPath);
    // A reload of the screen keeps its history entry, so it is still the launch.
    await act(() => router.invalidate());
    expect(readStoredScreen()).toBe(threadPath);
  });
});

describe("a sign-in at launch", () => {
  it.each([
    ["the last screen", "lastScreen", threadPath],
    ["the Office", "office", "/office"],
  ] as const)("leads to %s, and keeps the stored screen", async (_, openOn, opened) => {
    storeScreen(threadPath);
    const { router } = await launch(openOn, null);
    expect(router.state.location.pathname).toBe("/login");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Username" }), "rogier");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(opened);
    });
    expect(readStoredScreen()).toBe(threadPath);
  });
});

describe("moving between screens", () => {
  it("stores each screen the user opens, without its search params", async () => {
    const { router } = await launch();
    await act(() =>
      router.navigate({ to: "/threads/$sessionId", params: { sessionId: thread.session.id } }),
    );
    expect(readStoredScreen()).toBe(threadPath);
    await act(() => router.navigate({ to: "/office", search: { session: thread.session.id } }));
    expect(readStoredScreen()).toBe("/office");
  });

  it("leaves the stored screen alone while Settings is open", async () => {
    const { router } = await launch();
    await act(() => router.navigate({ to: "/office" }));
    await act(() => router.navigate({ to: "/settings/appearance" }));
    expect(router.state.location.pathname).toBe("/settings/appearance");
    expect(readStoredScreen()).toBe("/office");
  });

  it("stores the screen the user goes back or forward to, the launch screen included", async () => {
    storeScreen(threadPath);
    const { router } = await launch();
    await act(() => router.navigate({ to: "/office" }));
    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(readStoredScreen()).toBe(threadPath);
    });
    act(() => {
      router.history.forward();
    });
    await waitFor(() => {
      expect(readStoredScreen()).toBe("/office");
    });
  });

  it("replaces the thread id an older build stored", async () => {
    localStorage.setItem(`last-thread:${CONTROLLER_URL}`, thread.session.id);
    const { router } = await launch();
    await act(() => router.navigate({ to: "/" }));
    expect(localStorage.getItem(`last-thread:${CONTROLLER_URL}`)).toBeNull();
    expect(readStoredScreen()).toBe("/");
  });
});
