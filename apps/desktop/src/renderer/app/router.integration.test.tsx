import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import faceCss from "../faces/face.css?raw";
import iconCss from "../icons/icon.css?raw";
import markCss from "../marks/mark.css?raw";
import centeredScreenCss from "../screens/centered-screen.css?raw";
import shellCss from "../shell/shell.css?raw";
import sidebarCss from "../shell/sidebar.css?raw";
import baseCss from "../styles/base.css?raw";
import controlsCss from "../styles/controls.css?raw";
import tokensCss from "../styles/tokens.css?raw";
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
 * `<property>: <value>`, such as `-webkit-app-region: drag`.
 */
const expectDeclaration = (
  css: string,
  className: string,
  property: string,
  value: string,
): void => {
  // The look-behind keeps `height` from matching inside `line-height`.
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*(?<![-\\w])${property}:\\s*${value};`);
  expect(css).toMatch(rule);
};

/**
 * Every stylesheet the app's window loads, as text. A test cannot list the
 * folder: the renderer's program has no Node, and eslint keeps
 * `import.meta.glob` out of the desktop app. So a new stylesheet is added
 * here by name.
 */
const APP_STYLESHEETS = [
  tokensCss,
  baseCss,
  controlsCss,
  shellCss,
  sidebarCss,
  centeredScreenCss,
  faceCss,
  iconCss,
  markCss,
];

/**
 * Returns the selector of each rule in `stylesheets` that declares
 * `-webkit-app-region: drag`.
 */
const findDragSelectors = (stylesheets: ReadonlyArray<string>): Array<string> =>
  stylesheets.flatMap((css) =>
    Array.from(
      css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*-webkit-app-region:\s*drag;/g),
      (match) => match[1]!.trim(),
    ),
  );

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
  it("renders one drag strip in the shell, first, across the top of the window, taking no clicks", async () => {
    stubApi();
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
    // First, so that the `no-drag` controls in the band come later in the
    // document and take precedence over the strip.
    expect(document.querySelectorAll(".drag-strip")).toHaveLength(1);
    expect(document.querySelector(".app > .drag-strip:first-child")).not.toBeNull();
    expectDeclaration(shellCss, "drag-strip", "-webkit-app-region", "drag");
    // Not `fixed`: see the comment on `.drag-strip` in shell.css.
    expectDeclaration(shellCss, "drag-strip", "position", "absolute");
    expectDeclaration(shellCss, "drag-strip", "height", "52px");
    expectDeclaration(shellCss, "drag-strip", "pointer-events", "none");
  });

  it("makes the strip the only element in the shell that a stylesheet marks as a drag region", async () => {
    // One element owns the band, so no gap can open between two strips.
    stubApi();
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
    const dragElements = findDragSelectors(APP_STYLESHEETS).flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    expect(dragElements).toEqual([document.querySelector(".drag-strip")]);
  });

  it("lets the whole window drag on the connect screen, except the column", async () => {
    await renderApp(createFakeBridge());
    expect(document.querySelector(".centered-screen > .centered-column")).not.toBeNull();
    expectDeclaration(centeredScreenCss, "centered-screen", "-webkit-app-region", "drag");
    expectDeclaration(centeredScreenCss, "centered-column", "-webkit-app-region", "no-drag");
  });
});
