// `pnpm compare:bureau` proves that every icon draws the Bureau book's pixels
// at every size the pages use. These tests cover what the pixels cannot show:
// - the `ic` class, which keeps an icon from shrinking in a flex row;
// - that an icon is hidden from assistive technology;
// - the size when the caller passes none, which no specimen cell uses.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import * as icons from ".";

/** The names of the icon components: every export except the frame they share. */
const ICON_NAMES = Object.keys(icons).filter(
  (name): name is Exclude<keyof typeof icons, "IconFrame"> => name !== "IconFrame",
);

describe("icons", () => {
  it.each(ICON_NAMES)("%s draws one hidden .ic svg, 16 px by default", (name) => {
    const Icon = icons[name];
    const { container } = render(<Icon />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    const svg = svgs[0]!;
    expect(svg.getAttribute("class")).toBe("ic");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });
});
