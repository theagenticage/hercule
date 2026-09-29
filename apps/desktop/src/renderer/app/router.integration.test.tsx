import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import shellCss from "../shell/shell.css?raw";
import sidebarCss from "../shell/sidebar.css?raw";
import { createAppRouter } from "./router";

/**
 * Tests the shell as the app renders it at start-up: through the real router,
 * the root route, the shell's layout route and the index route.
 *
 * A window with a hidden title bar can only be moved by its drag regions, so
 * the shell must render them. jsdom drops `-webkit-app-region` when it parses
 * a stylesheet, so the test checks the two halves separately: the shell
 * renders the elements, and their stylesheets make those elements drag
 * regions.
 */

/** Renders the app at `/` and returns the element React renders into. */
const renderApp = async (): Promise<HTMLElement> => {
  const router = createAppRouter();
  await router.load();
  const { container } = render(<RouterProvider router={router} />);
  return container;
};

/** Checks that the stylesheet gives the rule for `.className` the declaration `-webkit-app-region: drag`. */
const expectDragRegion = (css: string, className: string): void => {
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*-webkit-app-region:\\s*drag;`);
  expect(css).toMatch(rule);
};

describe("the shell", () => {
  it("renders the sidebar's top strip as a drag region", async () => {
    const app = await renderApp();
    expect(app.querySelector(".app > .side > .side-top")).not.toBeNull();
    expectDragRegion(sidebarCss, "side-top");
  });

  it("renders the main pane's drag strip first, before any screen", async () => {
    const app = await renderApp();
    // First, so that a screen's `no-drag` controls come later in the document
    // and take precedence over the strip.
    expect(app.querySelector(".app > .main > .drag-strip:first-child")).not.toBeNull();
    expectDragRegion(shellCss, "drag-strip");
  });
});
