/**
 * Tests what the app draws as a plugin's mark: the paths of the mark a
 * plugin's record carries, and the initial of a plugin with none.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PluginMark } from "./plugin-mark";

const MARK_PATHS = ["M0 0h16v16H0z", "M4 4h8v8H4z"];

/** Renders the mark of `pluginId` among the plugins `plugin.query` would return, and returns its `<svg>`. */
const renderMark = (pluginId: string): SVGSVGElement => {
  const { container } = render(
    <PluginMark
      pluginId={pluginId}
      plugins={[
        { id: "github", displayName: "GitHub", mark: { paths: MARK_PATHS } },
        { id: "linear", displayName: "Linear" },
      ]}
      size={14}
    />,
  );
  return container.querySelector("svg")!;
};

describe("PluginMark", () => {
  it("draws each path of the plugin's mark in the text colour, at the size asked for", () => {
    const svg = renderMark("github");
    expect([...svg.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
      MARK_PATHS,
    );
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("text")).toBeNull();
  });

  it("draws the initial of the plugin's name for a plugin with no mark", () => {
    const svg = renderMark("linear");
    expect(svg.querySelector("text")?.textContent).toBe("L");
    expect(svg.querySelector("rect")).not.toBeNull();
    expect(svg.querySelector("path")).toBeNull();
  });

  it("draws the initial of the id for a plugin the list does not hold", () => {
    expect(renderMark("sentry").querySelector("text")?.textContent).toBe("S");
  });
});
