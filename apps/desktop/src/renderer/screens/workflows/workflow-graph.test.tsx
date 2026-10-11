/**
 * Tests the workflow graph: a plugin's action draws its plugin's mark, a
 * node's card opens and closes, Escape stays with the card, and the zoom
 * opens fitted, never below 80%, and follows the buttons and the keys.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowDefinition } from "@hercule/contract";
import { buildGraphDrawing } from "@hercule/client-core/graph-model";
import type { NodeCard } from "@hercule/client-core/node-details";
import { WorkflowGraph } from "./workflow-graph";
import { layOutGraphDrawing } from "./workflow-graph-layout";

/** A schedule starts `review`, which loops with `fix` and then opens a pull request. */
const REVIEW: WorkflowDefinition = {
  name: "Review",
  triggers: [{ id: "nightly", kind: "start", on: { schedule: "0 2 * * *" } }],
  steps: [
    { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review the diff." },
    { id: "fix", kind: "agent", agent: "a-coder", prompt: "Fix it." },
    { id: "open_pr", kind: "action", action: "github/pr.create" },
    { id: "wait", kind: "action", action: "sleep", terminal: true },
  ],
  edges: [
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "open_pr", to: "wait" },
  ],
};

const DRAWING = buildGraphDrawing(
  REVIEW,
  [
    { id: "a-reviewer", name: "Reviewer" },
    { id: "a-coder", name: "Coder" },
  ],
  [
    { id: "github/pr.create", displayName: "Open a GitHub pull request" },
    { id: "sleep", displayName: "Wait a while" },
  ],
);

/** The path of GitHub's mark, as `plugin.query` would return it. */
const GITHUB_MARK_PATH = "M0 0h16v16H0z";

const { size: SIZE } = layOutGraphDrawing(DRAWING);

/** The cards of the graph's nodes. The trigger's card has a time row, which the age clock formats. */
const CARDS: Record<string, NodeCard> = {
  nightly: {
    id: "nightly",
    kind: "start",
    kindText: "Start trigger",
    firesOn: "schedule",
    facts: [{ kind: "time", label: "Next", at: "2026-10-12T02:00:00Z", direction: "future" }],
    prompt: undefined,
  },
  review: {
    id: "review",
    kind: "agent",
    kindText: "Agent step",
    firesOn: null,
    facts: [{ kind: "text", label: "Agent", value: "Reviewer", isCode: false }],
    prompt: "Review the diff.",
  },
  fix: {
    id: "fix",
    kind: "agent",
    kindText: "Agent step",
    firesOn: null,
    facts: [],
    prompt: "Fix it.",
  },
};

/** Gives every element `width` as its client width, as a pane that wide reports it. */
const stubPaneWidth = (width: number) => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
};

/** Renders the graph of `DRAWING` beside a button outside it. */
const renderGraph = () =>
  render(
    <>
      <WorkflowGraph
        drawing={DRAWING}
        readCard={(nodeId) => CARDS[nodeId]}
        timezone="UTC"
        label="The steps of Review"
        plugins={[{ id: "github", displayName: "GitHub", mark: { paths: [GITHUB_MARK_PATH] } }]}
      />
      <button type="button">Outside</button>
      <input aria-label="Search" />
    </>,
  );

/**
 * Returns the open card's name, such as "review, Agent step", or `null` while
 * no card is open. The card stays in the page while closed, with no name.
 * jsdom hides every popover and computes no name for a hidden element, so
 * the name is read from the card's label.
 */
const readOpenCardName = () =>
  screen.getByRole("dialog", { hidden: true }).getAttribute("aria-label");

/** Returns the text of the open card. */
const readCardText = () => screen.getByRole("dialog", { hidden: true }).textContent;

/** Returns the zoom the pill shows, such as "80%". */
const readZoom = () => screen.getByRole("status", { name: "Zoom" }).textContent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a node's icon", () => {
  it("draws the mark of the plugin whose action a step calls, and a puzzle for a built-in action", () => {
    renderGraph();
    const openPr = screen.getByRole("button", { name: "open_pr, Open a GitHub pull request" });
    expect(openPr.querySelector(".node-lead path")?.getAttribute("d")).toBe(GITHUB_MARK_PATH);
    const wait = screen.getByRole("button", { name: "wait, Wait a while" });
    expect(wait.querySelector(".node-lead .br")).toBeNull();
    expect(wait.querySelector(".node-lead .ic")).not.toBeNull();
  });
});

describe("a node's card", () => {
  it("opens on a click on the node, and closes on a second click on it", async () => {
    const user = userEvent.setup();
    renderGraph();
    const node = screen.getByRole("button", { name: "review, Reviewer" });
    expect(node.getAttribute("aria-expanded")).toBe("false");

    await user.click(node);
    expect(readOpenCardName()).toBe("review, Agent step");
    expect(readCardText()).toContain("Review the diff.");
    expect(node.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("dialog", { hidden: true }));

    await user.click(node);
    expect(readOpenCardName()).toBeNull();
    expect(node.getAttribute("aria-expanded")).toBe("false");
  });

  it("moves to another node on a click on that node", async () => {
    const user = userEvent.setup();
    renderGraph();
    await user.click(screen.getByRole("button", { name: "review, Reviewer" }));
    await user.click(screen.getByRole("button", { name: "fix, Coder" }));
    expect(readOpenCardName()).toBe("fix, Agent step");
  });

  it("closes on a click outside it, and stays open on a click inside it", async () => {
    const user = userEvent.setup();
    renderGraph();
    await user.click(screen.getByRole("button", { name: "review, Reviewer" }));
    await user.click(screen.getByText("Review the diff."));
    expect(readOpenCardName()).toBe("review, Agent step");

    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(readOpenCardName()).toBeNull();
  });

  it("closes on Escape, keeps Escape from the page, and returns focus to the node", async () => {
    const user = userEvent.setup();
    renderGraph();
    const node = screen.getByRole("button", { name: "review, Reviewer" });
    await user.click(node);
    screen.getByRole("button", { name: "Outside" }).focus();
    const page = vi.fn();
    window.addEventListener("keydown", page);

    const isNotPrevented = fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    window.removeEventListener("keydown", page);
    expect(isNotPrevented).toBe(false);
    expect(page).not.toHaveBeenCalled();
    expect(readOpenCardName()).toBeNull();
    expect(document.activeElement).toBe(node);
  });

  it("leaves Escape in a text field to the field, and stays open", async () => {
    const user = userEvent.setup();
    renderGraph();
    await user.click(screen.getByRole("button", { name: "review, Reviewer" }));
    const search = screen.getByRole("textbox", { name: "Search" });
    search.focus();

    expect(fireEvent.keyDown(search, { key: "Escape" })).toBe(true);
    expect(readOpenCardName()).toBe("review, Agent step");
  });

  it("leaves Escape to the page while no card is open", () => {
    renderGraph();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });

  it("shows a time row's moment as the age clock formats it", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-11T12:00:00Z"), toFake: ["Date"] });
    try {
      const user = userEvent.setup();
      renderGraph();
      await user.click(screen.getByRole("button", { name: "nightly, Daily at 02:00" }));
      expect(readOpenCardName()).toBe("nightly, Start trigger");
      // Tomorrow's moment, within six days, shows as its weekday.
      expect(readCardText()).toContain("NextMon");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the graph's zoom", () => {
  it("opens at 80% in a pane too narrow for the graph at 80%", () => {
    stubPaneWidth(Math.round(SIZE.width * 0.5));
    renderGraph();
    expect(readZoom()).toBe("80%");
  });

  it("opens fitted to a pane wide enough for the graph at more than 80%", () => {
    stubPaneWidth(Math.round(SIZE.width * 0.9) + 24);
    renderGraph();
    expect(readZoom()).toBe("90%");
  });

  it("shows no zoom controls when the graph fits at 100%", () => {
    stubPaneWidth(SIZE.width + 24);
    renderGraph();
    expect(screen.queryByRole("status", { name: "Zoom" })).toBeNull();
  });

  it("zooms with the buttons", async () => {
    stubPaneWidth(Math.round(SIZE.width * 0.5) + 24);
    const user = userEvent.setup();
    renderGraph();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(readZoom()).toBe("100%");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(readZoom()).toBe("80%");
    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(readZoom()).toBe("50%");
  });

  it("keeps the focus on a zoom button at its end of the range, where it cannot act", async () => {
    stubPaneWidth(Math.round(SIZE.width * 0.5) + 24);
    const user = userEvent.setup();
    renderGraph();
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    zoomIn.focus();
    // 80% to 100%, 125%, 156% and 195%, then the 200% the zoom stops at.
    for (let press = 0; press < 5; press += 1) await user.keyboard("{Enter}");
    expect(readZoom()).toBe("200%");
    expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(zoomIn);

    await user.keyboard("{Enter}");
    expect(readZoom()).toBe("200%");
  });

  it("zooms with the keys while the graph has focus", () => {
    stubPaneWidth(Math.round(SIZE.width * 0.5) + 24);
    renderGraph();
    const pane = screen.getByRole("group", { name: "The steps of Review" });
    const press = (init: KeyboardEventInit) => fireEvent.keyDown(pane, init);

    expect(press({ key: "=", metaKey: true })).toBe(false);
    expect(readZoom()).toBe("100%");
    press({ key: "+", metaKey: true });
    expect(readZoom()).toBe("125%");
    press({ key: "-", metaKey: true });
    expect(readZoom()).toBe("100%");
    press({ key: "!", code: "Digit1", shiftKey: true });
    expect(readZoom()).toBe("50%");
    press({ key: "0", metaKey: true });
    expect(readZoom()).toBe("100%");
    // A key that does not zoom is left to the page.
    expect(press({ key: "f", metaKey: true })).toBe(true);
  });

  it("ignores the keys outside the graph", () => {
    stubPaneWidth(Math.round(SIZE.width * 0.5) + 24);
    renderGraph();
    fireEvent.keyDown(screen.getByRole("button", { name: "Outside" }), { key: "=", metaKey: true });
    expect(readZoom()).toBe("80%");
  });
});
