import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import centeredScreenCss from "../screens/centered-screen.css?raw";
import shellCss from "../shell/shell.css?raw";
import sidebarCss from "../shell/sidebar.css?raw";
import {
  CONTROLLER_URL,
  createFakeBridge,
  neverAnswer,
  refuseConnection,
  renderApp,
  startApp,
  stubApi,
} from "./testing";

/**
 * Tests the app as it starts: through boot's context, the real router, the
 * entry guard and the screen the guard settles on.
 *
 * A window with a hidden title bar can only be moved by its drag regions, so
 * every screen must render them. jsdom drops `-webkit-app-region` when it
 * parses a stylesheet, so a test checks the two halves separately: the screen
 * renders the elements, and their stylesheets set the region.
 */

/**
 * Checks that the stylesheet gives the rule for `.className` the declaration
 * `-webkit-app-region: <region>`.
 */
const expectAppRegion = (css: string, className: string, region: "drag" | "no-drag"): void => {
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*-webkit-app-region:\\s*${region};`);
  expect(css).toMatch(rule);
};

describe("where the app starts", () => {
  it("shows the connect screen when no controller is saved", async () => {
    const { router } = await renderApp(createFakeBridge());
    expect(router.state.location.pathname).toBe("/connect");
    expect(screen.getByRole("textbox", { name: "Controller address" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the sign-in screen when a controller is saved but no token", async () => {
    stubApi();
    const { router } = await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL }));
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.getByRole("textbox", { name: "Username" })).toBeTruthy();
  });

  it("shows the shell when a controller and a token are saved", async () => {
    stubApi();
    const { router } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    );
    expect(router.state.location.pathname).toBe("/");
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("goes back to the connect screen when the saved controller cannot be reached", async () => {
    stubApi({ "GET /api/v1/setup": refuseConnection });
    const { router } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    );
    expect(router.state.location.pathname).toBe("/connect");
    expect(screen.getByRole("alert").textContent).toBe(
      `Could not reach ${CONTROLLER_URL}. Check that the controller is running.`,
    );
    // The field holds the saved address, so the user can correct it.
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe(CONTROLLER_URL);
  });

  it("goes back to the connect screen when the saved controller is not set up", async () => {
    stubApi({ "GET /api/v1/setup": { body: { complete: false } } });
    const { router } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    );
    expect(router.state.location.pathname).toBe("/connect");
    expect(screen.getByRole("alert").textContent).toBe(
      "This controller is not set up yet. Press Connect to finish setup in the browser.",
    );
  });

  it("takes a signed-in user off the sign-in screen", async () => {
    stubApi();
    const { router } = await renderApp(
      createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    );
    await act(() => router.navigate({ to: "/login" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });
});

describe("a saved controller that does not answer at launch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Starts the app with a saved controller whose setup read never answers,
   * on fake timers, so a test can move the clock past the router's pending
   * delay and the request's time limit.
   */
  const startWithHungController = async () => {
    vi.useFakeTimers();
    stubApi({ "GET /api/v1/setup": neverAnswer });
    return startApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
  };

  it("shows nothing for the first second, then the connecting screen", async () => {
    await startWithHungController();
    await act(() => vi.advanceTimersByTimeAsync(900));
    expect(screen.queryByText(`Connecting to ${CONTROLLER_URL}…`)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.getByText(`Connecting to ${CONTROLLER_URL}…`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it("gives up after 5 seconds and shows the connect screen", async () => {
    const { router } = await startWithHungController();
    await act(() => vi.advanceTimersByTimeAsync(4900));
    expect(router.state.location.pathname).toBe("/");
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(router.state.location.pathname).toBe("/connect");
    expect(screen.getByRole("alert").textContent).toBe(
      `Could not reach ${CONTROLLER_URL}. Check that the controller is running.`,
    );
  });

  it("leads to the connect screen on Change, and stays there", async () => {
    const { router } = await startWithHungController();
    await act(() => vi.advanceTimersByTimeAsync(1100));
    act(() => {
      screen.getByRole("button", { name: "Change" }).click();
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(router.state.location.pathname).toBe("/connect");
    // The abandoned setup read gives up later. It must not move the user.
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(router.state.location.pathname).toBe("/connect");
    expect(router.state.location.search).toEqual({});
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the drag regions", () => {
  it("renders the sidebar's top strip in the shell as a drag region", async () => {
    stubApi();
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
    expect(document.querySelector(".app > .side > .side-top")).not.toBeNull();
    expectAppRegion(sidebarCss, "side-top", "drag");
  });

  it("renders the main pane's drag strip first, before any screen", async () => {
    stubApi();
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
    // First, so that a screen's `no-drag` controls come later in the document
    // and take precedence over the strip.
    expect(document.querySelector(".app > .main > .drag-strip:first-child")).not.toBeNull();
    expectAppRegion(shellCss, "drag-strip", "drag");
  });

  it("lets the whole window drag on the connect screen, except the column", async () => {
    await renderApp(createFakeBridge());
    expect(document.querySelector(".centered-screen > .centered-column")).not.toBeNull();
    expectAppRegion(centeredScreenCss, "centered-screen", "drag");
    expectAppRegion(centeredScreenCss, "centered-column", "no-drag");
  });
});
