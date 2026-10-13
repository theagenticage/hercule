/**
 * Tests the sidebar's layout as the signed-in app renders it: hiding and
 * showing the sidebar, resizing it from the keyboard, and keeping the layout
 * on this device. jsdom lays nothing out, so a drag, which reads where the
 * pointer is, is tested in the packaged app (e2e/desktop/sidebar-layout.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
} from "../app/testing";

const LAYOUT_KEY = "hercule.sidebar.layout";

beforeEach(() => {
  stubElementSize(272, 800);
});

afterEach(() => {
  localStorage.clear();
});

/** Starts the app signed in, and returns the fake bridge and the shell's element. */
const startShell = async () => {
  stubApi(buildSidebarHandlers(SIDEBAR_FIXTURE));
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  await renderApp(fake, { path: "/" });
  // The main pane, because a sidebar stored as hidden is out of the
  // accessibility tree.
  await screen.findByRole("main");
  const shell = document.querySelector<HTMLElement>(".app")!;
  return { fake, shell };
};

const readStoredLayout = (): unknown => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");

describe("the sidebar's layout", () => {
  it("hides and shows the sidebar by its buttons, the menu and Enter on the handle", async () => {
    const { fake, shell } = await startShell();

    await userEvent.click(screen.getByRole("button", { name: "Hide the sidebar ⌘B" }));
    expect(shell.dataset["sidebar"]).toBe("closed");
    expect(readStoredLayout()).toEqual({ width: 272, collapsed: true });
    // The sidebar's box turns closed a frame later, and the sidebar then
    // slides shut. jsdom knows no `content-visibility`, so the sidebar
    // leaving the accessibility tree is checked in the packaged app
    // (e2e/desktop/sidebar-layout.test.ts).
    await waitFor(() => {
      expect(shell.dataset["sidebarBox"]).toBe("closed");
    });
    // A hidden sidebar cannot hold the focus, so the focus goes from its
    // Hide button to the Show button.
    const show = screen.getByRole("button", { name: "Show the sidebar ⌘B" });
    expect(document.activeElement).toBe(show);

    await userEvent.click(show);
    expect(shell.dataset["sidebar"]).toBe("open");
    await screen.findByRole("navigation", { name: "Threads" });
    const handle = screen.getByRole("separator", { name: "Resize the sidebar" });
    expect(document.activeElement).toBe(handle);

    fake.sendMenuCommand("toggleSidebar");
    expect(shell.dataset["sidebar"]).toBe("closed");
    fake.sendMenuCommand("toggleSidebar");
    expect(shell.dataset["sidebar"]).toBe("open");

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize the sidebar" }), {
      key: "Enter",
    });
    expect(shell.dataset["sidebar"]).toBe("closed");
  });

  it("resizes the sidebar with its handle's keys and a double-click, and keeps the width", async () => {
    const { shell } = await startShell();
    const handle = screen.getByRole("separator", { name: "Resize the sidebar" });
    // jsdom's window is 1024px wide, which leaves room for the widest sidebar.
    expect(handle.getAttribute("aria-valuemax")).toBe("420");

    const slot = shell.querySelector<HTMLElement>(".side-slot")!;
    const pressAndRead = (key: string) => {
      fireEvent.keyDown(handle, { key });
      return {
        drawn: slot.style.getPropertyValue("--sidebar-w"),
        announced: handle.getAttribute("aria-valuenow"),
        stored: readStoredLayout(),
      };
    };
    expect(pressAndRead("ArrowRight")).toEqual({
      drawn: "288px",
      announced: "288",
      stored: { width: 288, collapsed: false },
    });
    expect(pressAndRead("ArrowLeft")).toMatchObject({ drawn: "272px", announced: "272" });
    expect(pressAndRead("End")).toMatchObject({ drawn: "420px", announced: "420" });
    expect(pressAndRead("Home")).toMatchObject({ drawn: "232px", announced: "232" });
    expect(pressAndRead("ArrowLeft")).toMatchObject({ drawn: "232px", announced: "232" });

    fireEvent.doubleClick(handle);
    expect(slot.style.getPropertyValue("--sidebar-w")).toBe("272px");
    expect(readStoredLayout()).toEqual({ width: 272, collapsed: false });
  });

  it("ends a drag the sidebar hides in the middle of, so nothing is left resizing", async () => {
    const { fake, shell } = await startShell();
    // jsdom has no pointer capture.
    Element.prototype.setPointerCapture = () => undefined;
    onTestFinished(() => {
      // @ts-expect-error -- removes the stand-in, so jsdom is as it was.
      delete Element.prototype.setPointerCapture;
    });
    const handle = screen.getByRole("separator", { name: "Resize the sidebar" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 272, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 1 });
    expect(shell.dataset["resizing"]).toBe("");

    fake.sendMenuCommand("toggleSidebar");
    expect(shell.dataset["resizing"]).toBeUndefined();
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(readStoredLayout()).toEqual({ width: 272, collapsed: true });

    fake.sendMenuCommand("toggleSidebar");
    expect(shell.dataset["resizing"]).toBeUndefined();
    expect(
      shell.querySelector<HTMLElement>(".side-slot")!.style.getPropertyValue("--sidebar-w"),
    ).toBe("272px");
  });

  it("draws the stored layout when the app starts", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ width: 340, collapsed: true }));
    const { shell } = await startShell();
    expect(shell.dataset["sidebar"]).toBe("closed");
    await userEvent.click(screen.getByRole("button", { name: "Show the sidebar ⌘B" }));
    expect(
      shell.querySelector<HTMLElement>(".side-slot")!.style.getPropertyValue("--sidebar-w"),
    ).toBe("340px");
  });
});
