import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Mark } from ".";

afterEach(cleanup);

/** Each mark state and the words assistive technology reads for it, as the Bureau book spells them. */
const STATE_WORDS = [
  ["working", "working"],
  ["waiting", "waiting on you"],
  ["done", "done"],
  ["failed", "failed"],
  ["paused", "paused"],
  ["idle", "idle"],
] as const;

describe("Mark", () => {
  it.each(STATE_WORDS)("draws the %s mark, named %j, with a 14 px glyph", (state, words) => {
    render(<Mark state={state} />);
    const mark = screen.getByRole("img", { name: words });
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("class")).toBe(`mark mark--${state}`);
    const glyphs = mark.querySelectorAll("svg");
    expect(glyphs).toHaveLength(1);
    const glyph = glyphs[0]!;
    expect(glyph.getAttribute("class")).toBe("ic");
    expect(glyph.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.getAttribute("width")).toBe("14");
    expect(glyph.getAttribute("height")).toBe("14");
  });

  it("draws the glyph at the size given", () => {
    render(<Mark state="done" size={16} />);
    const glyph = screen.getByRole("img", { name: "done" }).querySelector("svg")!;
    expect(glyph.getAttribute("width")).toBe("16");
    expect(glyph.getAttribute("height")).toBe("16");
  });

  it("hides a decorative mark from assistive technology", () => {
    const { container } = render(<Mark state="waiting" decorative />);
    const mark = container.firstElementChild!;
    expect(mark.getAttribute("class")).toBe("mark mark--waiting");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.hasAttribute("role")).toBe(false);
    expect(mark.hasAttribute("aria-label")).toBe(false);
  });

  it("fills the working mark's three dots", () => {
    render(<Mark state="working" />);
    const dots = screen.getByRole("img", { name: "working" }).querySelectorAll("circle");
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.getAttribute("fill")).toBe("currentColor");
      expect(dot.getAttribute("stroke")).toBe("none");
    }
  });

  it("fills the waiting mark's centre dot inside an outlined ring", () => {
    render(<Mark state="waiting" />);
    const [ring, dot] = screen
      .getByRole("img", { name: "waiting on you" })
      .querySelectorAll("circle");
    expect(ring!.getAttribute("r")).toBe("5.6");
    expect(ring!.hasAttribute("fill")).toBe(false);
    expect(dot!.getAttribute("r")).toBe("2.4");
    expect(dot!.getAttribute("fill")).toBe("currentColor");
    expect(dot!.getAttribute("stroke")).toBe("none");
  });
});
