import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  CancelledMark,
  DecisionMark,
  DoneMark,
  FailedMark,
  PausedMark,
  QueuedMark,
  RunGlyph,
  SessionGlyph,
  SkippedMark,
  TaskGlyph,
  WorkStateMark,
  WorkflowGlyph,
  WorkingMark,
} from "./marks";

const stateMarks = {
  working: WorkingMark,
  decision: DecisionMark,
  queued: QueuedMark,
  paused: PausedMark,
  done: DoneMark,
  failed: FailedMark,
  cancelled: CancelledMark,
  skipped: SkippedMark,
};

const entityGlyphs = {
  task: TaskGlyph,
  run: RunGlyph,
  session: SessionGlyph,
  workflow: WorkflowGlyph,
};

const everyMark = { ...stateMarks, ...entityGlyphs };

describe("the mark family", () => {
  it.each(Object.entries(everyMark))("%s draws an SVG on the 12px grid", (name, Mark) => {
    const { container } = render(<Mark />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.dataset.mark).toBe(name);
    expect(svg!.getAttribute("viewBox")).toBe("0 0 12 12");
    expect(svg!.getAttribute("width")).toBe("12");
    expect(svg!.getAttribute("height")).toBe("12");
  });

  it.each(Object.entries(everyMark))("%s is painted in currentColor only", (_n, Mark) => {
    const { container } = render(<Mark />);
    const markup = container.innerHTML;
    expect(markup).toContain("currentColor");
    expect(/#[0-9a-f]{3,6}|oklch\(|rgb\(/i.test(markup)).toBe(false);
  });

  it.each(Object.entries(everyMark))(
    "%s is hidden from screen readers, because the text beside it gives the meaning",
    (_n, Mark) => {
      const { container } = render(<Mark />);
      expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    },
  );

  it.each(Object.entries(everyMark))("%s takes a className from its caller", (_n, Mark) => {
    const { container } = render(<Mark className="size-[13px]" />);
    expect(container.querySelector("svg")!.classList.contains("size-[13px]")).toBe(true);
  });

  it("gives each state mark the fixed hue for its meaning", () => {
    const hues = {
      working: "text-live",
      decision: "text-attn",
      queued: "text-faint",
      paused: "text-attn",
      done: "text-ok",
      failed: "text-fail",
      cancelled: "text-faint",
      skipped: "text-faint",
    };
    for (const [name, hue] of Object.entries(hues)) {
      const Mark = stateMarks[name as keyof typeof stateMarks];
      const { container } = render(<Mark />);
      expect(container.querySelector("svg")!.classList.contains(hue), name).toBe(true);
    }
  });

  it("leaves entity glyphs in the ink family, never a semantic hue", () => {
    for (const [name, Glyph] of Object.entries(entityGlyphs)) {
      const { container } = render(<Glyph />);
      const classes = container.querySelector("svg")!.getAttribute("class") ?? "";
      expect(/text-(live|attn|ok|fail)/.test(classes), name).toBe(false);
    }
  });

  it("draws the decision mark with a slightly heavier stroke than the other marks", () => {
    const readStrokeWidth = (svg: SVGSVGElement) => svg.getAttribute("stroke-width");
    const { container: decision } = render(<DecisionMark />);
    const { container: done } = render(<DoneMark />);
    expect(readStrokeWidth(done.querySelector("svg")!)).toBe("1.15");
    expect(readStrokeWidth(decision.querySelector("svg")!)).toBe("1.35");
  });

  it("draws the skipped mark as a double chevron: two strokes pointing onward", () => {
    const { container } = render(<SkippedMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("stroke-width")).toBe("1.15");
    // Two open chevrons, each a move and two lines, drawn with no fill.
    const drawing = [...svg.querySelectorAll("path")]
      .map((path) => path.getAttribute("d"))
      .join(" ");
    expect(drawing.match(/[Mm]/g)).toHaveLength(2);
    expect(svg.getAttribute("fill")).toBe("none");
  });

  it("gives the working mark three bars that a stylesheet can animate", () => {
    const { container } = render(<WorkingMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.classList.contains("hercule-equalizer")).toBe(true);
    expect(svg.querySelectorAll("rect")).toHaveLength(3);
  });
});

describe("WorkStateMark", () => {
  it.each([
    ["pending", "queued"],
    ["running", "working"],
    ["completed", "done"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["skipped", "skipped"],
  ] as const)("draws the %s state with the %s mark", (state, mark) => {
    const { container } = render(<WorkStateMark state={state} />);
    expect(container.querySelector("svg")?.dataset.mark).toBe(mark);
  });

  it("draws no mark for work the run has not reached", () => {
    const { container } = render(<WorkStateMark state="unreached" />);
    expect(container.innerHTML).toBe("");
  });
});
