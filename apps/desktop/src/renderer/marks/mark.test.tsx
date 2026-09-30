import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Mark, type MarkState } from ".";

afterEach(cleanup);

const STATES = [
  "working",
  "waiting",
  "done",
  "failed",
  "paused",
  "idle",
] as const satisfies ReadonlyArray<MarkState>;

/** Renders the mark of `state` and returns its root element. */
function renderMark(state: MarkState): Element {
  const { container } = render(<Mark state={state} />);
  return container.firstElementChild!;
}

describe("Mark", () => {
  it.each(STATES)("draws the %s mark with a 14 px glyph", (state) => {
    const mark = renderMark(state);
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("class")).toBe(`mark mark--${state}`);
    const glyphs = mark.querySelectorAll("svg");
    expect(glyphs).toHaveLength(1);
    const glyph = glyphs[0]!;
    expect(glyph.getAttribute("class")).toBe("ic");
    expect(glyph.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(glyph.getAttribute("width")).toBe("14");
    expect(glyph.getAttribute("height")).toBe("14");
  });

  it("hides the mark from assistive technology", () => {
    const mark = renderMark("waiting");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.hasAttribute("role")).toBe(false);
    expect(mark.hasAttribute("aria-label")).toBe(false);
  });

  it("fills the working mark's three dots", () => {
    const dots = renderMark("working").querySelectorAll("circle");
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.getAttribute("fill")).toBe("currentColor");
      expect(dot.getAttribute("stroke")).toBe("none");
    }
  });

  it("fills the waiting mark's centre dot inside an outlined ring", () => {
    const [ring, dot] = renderMark("waiting").querySelectorAll("circle");
    expect(ring!.getAttribute("r")).toBe("5.6");
    expect(ring!.hasAttribute("fill")).toBe(false);
    expect(dot!.getAttribute("r")).toBe("2.4");
    expect(dot!.getAttribute("fill")).toBe("currentColor");
    expect(dot!.getAttribute("stroke")).toBe("none");
  });
});
