/**
 * Tests what Intake draws as a signal's source mark: the plugin's mark for a
 * plugin's signal, the logo mark for the core, and Hercule's face for its
 * offer of an Ignore Rule. What a plugin's mark looks like is `PluginMark`'s
 * test.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { Signal } from "@hercule/contract";
import { SignalMark, SourceMark } from "./source-mark";

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

describe("SignalMark", () => {
  const signal: Signal = {
    id: "s1",
    kind: "offer",
    origin: { type: "api", actor: "system", eventIds: [], reason: "test" },
    title: "Ignore Review requested where Repository is acme/webshop?",
    priority: "normal",
    blocks: [],
    actions: [],
    match: {},
    status: "open",
    createdAt: "2026-10-12T09:00:00.000Z",
  };

  /** Renders the mark of `drawn`, and returns its `<svg>`. */
  const renderSignalMark = (drawn: Signal): SVGSVGElement => {
    const { container } = render(<SignalMark signal={drawn} plugins={[]} size={16} />);
    return container.querySelector("svg")!;
  };

  it("draws Hercule's face for its offer of an Ignore Rule", () => {
    const offer = { ...signal, ignoreRule: { kind: "github/review-requested", match: {} } };
    const face = renderSignalMark(offer);
    expect(face.getAttribute("class")).toContain("cr");
    // Drawn larger than the 16px square, which it overflows by 3px a side.
    expect(face.getAttribute("width")).toBe("22");
    expect((face.parentElement as HTMLElement).style.margin).toBe("-3px");
  });

  it("draws the source's mark for any other signal, a triage offer included", () => {
    expect(renderSignalMark(signal).getAttribute("class")).toBe("logo");
  });
});
