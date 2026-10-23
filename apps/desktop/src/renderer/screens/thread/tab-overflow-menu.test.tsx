/**
 * Tests the "+n" button of the header's tabs and its menu: what the button
 * says, what each row shows, and that taking a row opens its session and
 * closes the menu. jsdom has no popover API, so the menu's element is always
 * drawn, `hidePopover` is replaced by a spy, and the browser's toggle event
 * is sent by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type JSX } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { SessionTab } from "@hercule/client-core";
import { TabOverflowMenu } from "./tab-overflow-menu";

const hidePopover = vi.fn();

beforeEach(() => {
  HTMLElement.prototype.hidePopover = hidePopover;
});

afterEach(() => {
  cleanup();
  hidePopover.mockClear();
});

/** Returns a tab with the fields a test does not care about filled in. */
const buildTab = (overrides: Partial<SessionTab> & { readonly sessionId: string }): SessionTab => ({
  label: overrides.sessionId,
  title: `Title of ${overrides.sessionId}`,
  pose: "idle",
  status: "age",
  activityAt: new Date().toISOString(),
  done: false,
  providerId: null,
  model: "Opus 5.5",
  ...overrides,
});

const REVIEW = buildTab({
  sessionId: "s-review",
  label: "review",
  title: "Adversarial review of the payout endpoints",
  pose: "working",
  status: "working",
  model: "GPT 5.4",
});
const TITLE_ONLY = buildTab({
  sessionId: "s-title",
  label: "Ask whether Stripe can send payouts",
  title: "Ask whether Stripe can send payouts",
});
const WAITING = buildTab({
  sessionId: "s-wait",
  label: "tests",
  pose: "waiting",
  status: "question",
});

/** What `renderMenu` returns. */
interface RenderedMenu {
  /** Returns the path the router is at. */
  readonly readPath: () => string;
  /** Replaces the hidden tabs, as the header does when it lays out again. */
  readonly setTabs: (tabs: readonly SessionTab[]) => void;
}

/** Renders the menu in a router that has the thread route. */
const renderMenu = async (
  initialTabs: readonly SessionTab[],
  openId: string | null = null,
): Promise<RenderedMenu> => {
  let setTabs: (tabs: readonly SessionTab[]) => void = () => undefined;
  function Harness(): JSX.Element {
    const [tabs, replaceTabs] = useState(initialTabs);
    setTabs = replaceTabs;
    return (
      <nav>
        <a href="/threads/s-open" data-tab="s-open" aria-current="page">
          open tab
        </a>
        <TabOverflowMenu tabs={tabs} openId={openId} />
      </nav>
    );
  }
  const root = createRootRoute({ component: Harness });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/threads/$sessionId",
  });
  const router = createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("button", { hidden: true });
  return {
    readPath: () => router.state.location.pathname,
    setTabs: (tabs) => {
      act(() => {
        setTabs(tabs);
      });
    },
  };
};

/** Sends the toggle event the browser sends when the menu opens or closes. */
const sendToggle = (newState: "open" | "closed"): void => {
  act(() => {
    fireEvent(
      screen.getByRole("menu", { hidden: true }),
      Object.assign(new Event("toggle"), { newState, oldState: "closed" }),
    );
  });
};

describe("TabOverflowMenu", () => {
  it("is an invisible measuring button with no rows while no tab is hidden", async () => {
    await renderMenu([]);

    const button = screen.getByRole("button", { hidden: true });
    expect(button.textContent).toBe("+1");
    expect(button.classList.contains("is-idle")).toBe(true);
    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.tabIndex).toBe(-1);
    expect(button.hasAttribute("data-tab-overflow")).toBe(true);
    expect(screen.queryAllByRole("menuitem", { hidden: true })).toHaveLength(0);
  });

  it("shows the count of hidden tabs and names it", async () => {
    await renderMenu([REVIEW, TITLE_ONLY]);

    const button = screen.getByRole("button", { name: "2 more threads" });
    expect(button.textContent).toBe("+2");
    expect(button.classList.contains("is-idle")).toBe(false);
  });

  it("says 'thread' for one hidden tab", async () => {
    await renderMenu([REVIEW]);

    expect(screen.getByRole("button", { name: "1 more thread" })).toBeTruthy();
  });

  it("tells a hidden question by the waiting mark and in the button's name", async () => {
    await renderMenu([REVIEW, WAITING]);
    const button = screen.getByRole("button", { name: "2 more threads, 1 waiting on you" });
    expect(button.querySelector(".mark--waiting")).not.toBeNull();
    cleanup();

    await renderMenu([REVIEW]);
    const quiet = screen.getByRole("button", { name: "1 more thread" });
    expect(quiet.querySelector(".mark--waiting")).toBeNull();
  });

  it("lists each hidden tab with its label, model and state, and a title-only label lighter", async () => {
    await renderMenu([REVIEW, TITLE_ONLY], "s-review");

    const menu = screen.getByRole("menu", { hidden: true });
    expect(menu.textContent).toContain("2 more");
    const review = within(menu).getByRole("menuitem", {
      name: "review, Adversarial review of the payout endpoints, working",
      hidden: true,
    });
    expect(review.textContent).toContain("review");
    expect(review.textContent).toContain("GPT 5.4");
    expect(review.textContent).toContain("Working");
    expect(review.classList.contains("is-current")).toBe(true);
    expect(review.getAttribute("href")).toBe("/threads/s-review");
    expect(review.getAttribute("title")).toBe("Adversarial review of the payout endpoints");
    expect(review.querySelector(".is-title")).toBeNull();

    const titleOnly = within(menu).getByRole("menuitem", {
      name: "Ask whether Stripe can send payouts, idle",
      hidden: true,
    });
    expect(titleOnly.classList.contains("is-current")).toBe(false);
    expect(titleOnly.querySelector(".is-title")).not.toBeNull();
  });

  it("names a done tab as done, with the done mark", async () => {
    await renderMenu([buildTab({ sessionId: "s-done", label: "lead", done: true })]);

    const row = screen.getByRole("menuitem", {
      name: "lead, Title of s-done, done",
      hidden: true,
    });
    expect(row.querySelector(".mark--done")).not.toBeNull();
  });

  it("opens the session of a row and closes the menu when the row is taken", async () => {
    const { readPath } = await renderMenu([REVIEW, TITLE_ONLY]);
    sendToggle("open");
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("menuitem", { name: /^Ask whether Stripe can send payouts/, hidden: true }),
    );

    expect(hidePopover).toHaveBeenCalledTimes(1);
    expect(readPath()).toBe("/threads/s-title");
  });

  it("steps through the rows with the arrow keys and takes the focused row with Enter", async () => {
    const { readPath } = await renderMenu([REVIEW, TITLE_ONLY]);
    sendToggle("open");
    const user = userEvent.setup();

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-item")).toBe("s-title");
    await user.keyboard("{Enter}");

    expect(readPath()).toBe("/threads/s-title");
    expect(hidePopover).toHaveBeenCalled();
  });

  it("closes an open menu when the list of hidden tabs changes, and not when it stays", async () => {
    const { setTabs } = await renderMenu([REVIEW, TITLE_ONLY]);
    sendToggle("open");

    setTabs([{ ...REVIEW, status: "queued" }, TITLE_ONLY]);
    expect(hidePopover).not.toHaveBeenCalled();

    setTabs([REVIEW]);
    expect(hidePopover).toHaveBeenCalledTimes(1);
  });

  it("moves the focus to the open tab when the last hidden tab goes while the menu is open", async () => {
    const { setTabs } = await renderMenu([REVIEW]);
    sendToggle("open");
    screen.getByRole("menuitem", { hidden: true }).focus();

    setTabs([]);

    expect(document.activeElement).toBe(screen.getByRole("link", { name: "open tab" }));
  });
});
