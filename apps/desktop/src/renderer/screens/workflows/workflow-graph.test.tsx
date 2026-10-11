/**
 * Tests the workflow graph: a plugin's action draws its plugin's mark, a
 * node's card opens and closes, Escape stays with the card, the zoom opens
 * fitted, never below 80%, and follows the buttons and the keys, and a run
 * draws on top of the graph and plays only the changes made while it is
 * open.
 *
 * Classes are checked one by one, so a test does not break when an element
 * gains a class it does not care about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowDefinition } from "@hercule/contract";
import {
  buildGraphDrawing,
  type EdgeOnRun,
  type NodeRunState,
  type RunOverlay,
} from "@hercule/client-core/graph-model";
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
    run: null,
  },
  review: {
    id: "review",
    kind: "agent",
    kindText: "Agent step",
    firesOn: null,
    facts: [{ kind: "text", label: "Agent", value: "Reviewer", isCode: false, isError: false }],
    prompt: "Review the diff.",
    run: null,
  },
  fix: {
    id: "fix",
    kind: "agent",
    kindText: "Agent step",
    firesOn: null,
    facts: [],
    prompt: "Fix it.",
    run: null,
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

/**
 * The overlay of a run at `states`, by node id; every other node is
 * unreached. `edges` gives the run's state at the edges, by their ends. The
 * stub to the end is fired once its step is done, and not yet otherwise.
 */
const buildOverlay = (
  states: Readonly<Record<string, NodeRunState>>,
  edges: Readonly<Record<string, EdgeOnRun>> = {},
  iterationLabels: Readonly<Record<string, string>> = {},
): RunOverlay => ({
  nodes: new Map(
    DRAWING.nodes.map((node) => [
      node.id,
      { state: states[node.id] ?? "unreached", iterationLabel: iterationLabels[node.id] },
    ]),
  ),
  edges: new Map(
    DRAWING.edges.map((edge) => [
      edge.id,
      edges[`${edge.from} ${edge.to}`] ?? {
        travel: "notYet",
        isFailedEdge: false,
        traversalBadge: undefined,
      },
    ]),
  ),
  endStubs: new Map(
    DRAWING.nodes
      .filter((node) => node.terminal)
      .map((node) => [node.id, states[node.id] === "done" ? "fired" : "notYet"]),
  ),
});

/** Checks that `element` has every class of `present` and none of `absent`. */
const expectClasses = (
  element: Element | null | undefined,
  present: ReadonlyArray<string>,
  absent: ReadonlyArray<string> = [],
) => {
  expect(element).toBeTruthy();
  for (const name of present) expect(element!.classList.contains(name), name).toBe(true);
  for (const name of absent) expect(element!.classList.contains(name), name).toBe(false);
};

/** Returns the classes of `element` that draw a run on it: those that start with `is-`. */
const listRunClasses = (element: Element): ReadonlyArray<string> =>
  [...element.classList].filter((name) => name.startsWith("is-"));

/** Renders the graph of `DRAWING` with `overlay`, and returns a function that draws it again with another. */
const renderRun = (overlay: RunOverlay | undefined) => {
  const graph = (next: RunOverlay | undefined) => (
    <WorkflowGraph
      drawing={DRAWING}
      readCard={(nodeId) => CARDS[nodeId]}
      timezone="UTC"
      label="The steps of Review"
      plugins={[]}
      overlay={next}
    />
  );
  const { rerender, container } = render(graph(overlay));
  return {
    container,
    drawAgain: (next: RunOverlay | undefined) => {
      rerender(graph(next));
    },
  };
};

/** Returns the button of the node with `id`. */
const findNode = (container: HTMLElement, id: string) =>
  [...container.querySelectorAll<HTMLElement>(".node")].find(
    (node) => node.querySelector(".node-title > b")?.textContent === id,
  )!;

describe("a run on the graph", () => {
  it("draws nothing of a run without an overlay", () => {
    const { container } = renderRun(undefined);
    expect(container.querySelectorAll(".node-mark, .node-ring, .node-times")).toHaveLength(0);
    for (const node of container.querySelectorAll(".node")) {
      expect(listRunClasses(node)).toEqual([]);
    }
    expectClasses(findNode(container, "review"), ["node--step"]);
    expectClasses(findNode(container, "nightly"), ["node--trigger"]);
    expect(container.querySelectorAll("marker")).toHaveLength(1);
    for (const edge of container.querySelectorAll(".graph-edges path:not(.arrow)")) {
      expectClasses(edge, ["edge"]);
      expect(listRunClasses(edge)).toEqual([]);
    }
  });

  it("marks each card with where the run is at it, and rings the ones that need a look", () => {
    const { container } = renderRun(
      buildOverlay({ nightly: "fired", review: "waiting", fix: "failed", open_pr: "pending" }),
    );
    const readMark = (id: string) => {
      const mark = findNode(container, id).querySelector(".node-mark > .mark");
      return mark === null ? undefined : [...mark.classList].find((name) => name !== "mark");
    };
    expect(readMark("nightly")).toBe("mark--done");
    expect(readMark("review")).toBe("mark--waiting");
    expect(readMark("fix")).toBe("mark--failed");
    expect(readMark("open_pr")).toBeUndefined();
    expect(readMark("wait")).toBeUndefined();

    const isRinged = (id: string) => findNode(container, id).querySelector(".node-ring") !== null;
    expect(isRinged("review")).toBe(true);
    expect(isRinged("fix")).toBe(true);
    expect(isRinged("nightly")).toBe(false);
    expect(isRinged("open_pr")).toBe(false);

    // The state's class picks the ring's colour, and half opacity for a card the run did not reach.
    expect(listRunClasses(findNode(container, "wait"))).toEqual(["is-unreached"]);
    expect(listRunClasses(findNode(container, "open_pr"))).toEqual(["is-pending"]);
  });

  it("puts how often the run came to a step after its id", () => {
    const { container } = renderRun(buildOverlay({ review: "working" }, {}, { review: "×2" }));
    expect(findNode(container, "review").querySelector(".node-times")?.textContent).toBe("×2");
    expect(findNode(container, "fix").querySelector(".node-times")).toBeNull();
  });

  it("names where the run is at a node in the node's name, in its card's words", () => {
    renderRun(buildOverlay({ review: "waiting", nightly: "fired" }));
    expect(screen.getByRole("button", { name: "review, Reviewer, Waiting on you" })).toBeTruthy();
    // A start trigger's state reads as whether it started the run.
    expect(screen.getByRole("button", { name: /^nightly, .*, Started this run$/ })).toBeTruthy();
  });

  it("tones each edge by how far the run came along it, and shows the run's count on a limit", () => {
    const { container } = renderRun(
      buildOverlay(
        { review: "failed", fix: "done" },
        {
          "fix review": { travel: "fired", isFailedEdge: true, traversalBadge: "3/3" },
          "review fix": { travel: "fired", isFailedEdge: false, traversalBadge: undefined },
          "review open_pr": { travel: "notTaken", isFailedEdge: false, traversalBadge: undefined },
        },
      ),
    );
    const edgeOf = (from: string, to: string) => {
      const index = DRAWING.edges.findIndex((edge) => edge.from === from && edge.to === to);
      return container.querySelectorAll(".graph-edges > path")[index]!;
    };
    expect(listRunClasses(edgeOf("fix", "review"))).toEqual(["is-failed"]);
    expect(edgeOf("fix", "review").getAttribute("marker-end")).toMatch(/-is-failed\)$/);
    expect(listRunClasses(edgeOf("review", "fix"))).toEqual(["is-fired"]);
    // An edge the run did not take is dashed, and keeps the plain arrowhead.
    expect(listRunClasses(edgeOf("review", "open_pr"))).toEqual(["is-not-taken"]);
    expect(edgeOf("review", "open_pr").getAttribute("marker-end")).toMatch(/graph-arrow-[\w-]+\)$/);
    expect(edgeOf("review", "open_pr").getAttribute("marker-end")).not.toMatch(/-is-/);
    expect(container.querySelectorAll("marker")).toHaveLength(5);

    expectClasses(screen.getByText("3/3"), ["edge-label", "edge-label--count", "is-failed"]);
    expect(screen.queryByText("≤ 3")).toBeNull();
  });

  it("tones the stub to the end as the overlay says", () => {
    const { container, drawAgain } = renderRun(buildOverlay({ wait: "done" }));
    const readStub = () => listRunClasses(container.querySelector(".graph-edges g > path")!);
    expect(readStub()).toEqual(["is-fired"]);
    drawAgain(buildOverlay({}));
    expect(readStub()).toEqual(["is-not-yet"]);
    // An ended run that never did the last step did not take its stub.
    drawAgain({ ...buildOverlay({}), endStubs: new Map([["wait", "notTaken"]]) });
    expect(readStub()).toEqual(["is-not-taken"]);
  });

  it("plays no change on the run it opens with", () => {
    const { container } = renderRun(buildOverlay({ review: "waiting" }));
    expect(container.querySelectorAll(".is-new, .is-brightening, .is-dimming")).toHaveLength(0);
  });

  it("plays a node's change made while the graph is open, and only that node's", () => {
    const { container, drawAgain } = renderRun(
      buildOverlay({ nightly: "fired", review: "working", fix: "pending" }),
    );
    drawAgain(buildOverlay({ nightly: "fired", review: "waiting", fix: "skipped" }));

    const review = findNode(container, "review");
    expect(listRunClasses(review)).toEqual(["is-waiting"]);
    expectClasses(review.querySelector(".node-ring"), ["is-new"]);
    expectClasses(review.querySelector(".node-mark"), ["is-new"]);
    expectClasses(findNode(container, "fix"), ["is-skipped", "is-dimming"]);
    expectClasses(findNode(container, "nightly").querySelector(".node-mark"), [], ["is-new"]);

    drawAgain(buildOverlay({ nightly: "fired", review: "working", fix: "skipped" }, {}, {}));
    expect(listRunClasses(findNode(container, "fix"))).toEqual(["is-skipped"]);
    expect(findNode(container, "review").querySelector(".node-ring")).toBeNull();
  });

  it("brightens a card the run reaches", () => {
    const { container, drawAgain } = renderRun(buildOverlay({}));
    drawAgain(buildOverlay({ review: "working" }));
    expectClasses(findNode(container, "review"), ["is-working", "is-brightening"]);
  });
});
