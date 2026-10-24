/**
 * Tests the "+n" button of the header's tabs and its menu: what the button
 * says, what each row shows, and that taking a row opens its session and
 * closes the menu. jsdom has no popover API, so the menu's element is always
 * drawn, `hidePopover` is replaced by a spy, and the browser's toggle event
 * is sent by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState, type JSX } from "react";
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
import { ThreadTabsPill } from "./header-pills";
import { TabOverflowMenu } from "./tab-overflow-menu";

const hidePopover = vi.fn();

beforeEach(() => {
  HTMLElement.prototype.hidePopover = hidePopover;
});

afterEach(() => {
  cleanup();
  hidePopover.mockClear();
});

/**
 * Returns a tab with the fields a test does not care about filled in. A test
 * that reads a tab's accessible name passes it, because client-core decides it.
 */
const buildTab = (overrides: Partial<SessionTab> & { readonly sessionId: string }): SessionTab => ({
  kind: "thread",
  label: overrides.sessionId,
  title: `Title of ${overrides.sessionId}`,
  hasRoleLabel: true,
  accessibleName: `${overrides.sessionId}, idle`,
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
  accessibleName: "review, Adversarial review of the payout endpoints, working",
  pose: "working",
  status: "working",
  model: "GPT 5.4",
});
const TITLE_ONLY = buildTab({
  sessionId: "s-title",
  label: "Ask whether Stripe can send payouts",
  title: "Ask whether Stripe can send payouts",
  hasRoleLabel: false,
  accessibleName: "Ask whether Stripe can send payouts, idle",
});
const WAITING = buildTab({
  sessionId: "s-wait",
  label: "tests",
  accessibleName: "tests, Title of s-wait, waiting on you",
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

/** Draws the open tab as a session's tab: a link. */
const OpenSessionTab = ({ sessionId }: { readonly sessionId: string }): JSX.Element => (
  <a href={`/threads/${sessionId}`} data-tab={sessionId} aria-current="page">
    open tab
  </a>
);

/** Renders the menu in a router that has the thread route. */
const renderMenu = async (
  initialTabs: readonly SessionTab[],
  openSessionId = "s-open",
): Promise<RenderedMenu> => {
  let setTabs: (tabs: readonly SessionTab[]) => void = () => undefined;
  function Harness(): JSX.Element {
    const [tabs, replaceTabs] = useState(initialTabs);
    useEffect(() => {
      setTabs = replaceTabs;
    }, [replaceTabs]);
    return (
      <nav>
        <OpenSessionTab sessionId={openSessionId} />
        <TabOverflowMenu
          tabs={tabs}
          openSessionId={openSessionId}
          restoreFocus={() =>
            document.querySelector<HTMLElement>(`[data-tab="${openSessionId}"]`)?.focus()
          }
        />
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

  it("says 'sessions' when a hidden tab is not a Thread", async () => {
    await renderMenu([REVIEW, buildTab({ sessionId: "s-agent", kind: "agent" })]);

    expect(screen.getByRole("button", { name: "2 more sessions" })).toBeTruthy();
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
    await renderMenu([
      buildTab({
        sessionId: "s-done",
        label: "lead",
        done: true,
        accessibleName: "lead, Title of s-done, done",
      }),
    ]);

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

/**
 * The widths of the model of a layout for `ThreadTabsPill`, which `useTabOverflow`
 * measures: jsdom has none, so each part has a fixed width and the room is set by the test.
 */
const TAB_WIDTH = 100;
const OVERFLOW_BUTTON_WIDTH = 48;
const CRUMB_WIDTH = 30;
const NARROW_ROOM = 200;
const WIDE_ROOM = 1000;

describe("TabOverflowMenu in a Draft Thread's header", () => {
  let roomWidth = NARROW_ROOM;
  let resizeCallbacks: Array<() => void> = [];

  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeCallbacks.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const width = this.classList.contains("thread-tabs-room")
        ? roomWidth
        : this.hasAttribute("data-tab-overflow")
          ? OVERFLOW_BUTTON_WIDTH
          : this.hasAttribute("data-tab")
            ? TAB_WIDTH
            : CRUMB_WIDTH;
      return { width, left: 0, right: width, top: 0, bottom: 0, height: 0, x: 0, y: 0 } as DOMRect;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Renders the draft's real tabs pill with the tab of `REVIEW` in it. */
  const renderDraftTabs = async (): Promise<void> => {
    function Harness(): JSX.Element {
      return (
        <ThreadTabsPill
          label="Draft thread"
          crumbs={<span>payments</span>}
          workName={null}
          tabs={[REVIEW]}
          open={{ kind: "draft" }}
          newThread={null}
        />
      );
    }
    const root = createRootRoute({ component: Harness });
    const thread = createRoute({ getParentRoute: () => root, path: "/threads/$sessionId" });
    const router = createRouter({
      routeTree: root.addChildren([thread]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);
    await screen.findByRole("navigation");
  };

  it("moves the focus to the New thread tab when the window widens until no tab is hidden", async () => {
    await renderDraftTabs();
    expect(screen.getByRole("button", { name: "1 more thread" })).toBeTruthy();
    sendToggle("open");
    screen.getByRole("menuitem", { hidden: true }).focus();

    roomWidth = WIDE_ROOM;
    act(() => {
      for (const callback of resizeCallbacks) callback();
    });

    expect(screen.queryAllByRole("menuitem", { hidden: true })).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByText("New thread"));
  });
});
