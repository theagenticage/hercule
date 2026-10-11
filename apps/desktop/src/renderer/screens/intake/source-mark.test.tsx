/**
 * Tests what Intake draws as a signal's source mark: the plugin's mark for a
 * plugin's signal, and the logo mark for the core. What a plugin's mark
 * looks like is `PluginMark`'s test.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SourceMark } from "./source-mark";

/** Renders the source mark of `pluginId`, and returns its `<svg>`. */
const renderMark = (pluginId: string | null): SVGSVGElement => {
  const { container } = render(
    <SourceMark
      pluginId={pluginId}
      plugins={[{ id: "linear", displayName: "Linear" }]}
      size={14}
    />,
  );
  return container.querySelector("svg")!;
};

describe("SourceMark", () => {
  it("draws the plugin's mark for a plugin's signal", () => {
    expect(renderMark("linear").querySelector("text")?.textContent).toBe("L");
  });

  it("draws the logo mark for the core", () => {
    expect(renderMark(null).getAttribute("class")).toBe("logo");
  });
});
