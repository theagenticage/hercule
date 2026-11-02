import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { stubIntersectionObserver } from "../../app/testing";
import { useSectionInView } from "./use-section-in-view";

const SECTION_IDS = ["machines", "software"] as const;

/** A scroll area with a section for each of `ids`, and a button that jumps to each one. */
function Page({ ids = SECTION_IDS }: { readonly ids?: ReadonlyArray<string> }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { activeSectionId, scrollToSection } = useSectionInView(scrollRef, ids);
  return (
    <div>
      <p data-testid="active">{activeSectionId ?? "none"}</p>
      {ids.map((id) => (
        <button key={id} type="button" onClick={() => scrollToSection(id)}>
          Jump to {id}
        </button>
      ))}
      <div ref={scrollRef}>
        {ids.map((id) => (
          <section key={id} id={id} data-testid={id} />
        ))}
      </div>
    </div>
  );
}

const readActive = (): string => screen.getByTestId("active").textContent;

describe("useSectionInView", () => {
  let report: ReturnType<typeof stubIntersectionObserver>;
  beforeEach(() => {
    report = stubIntersectionObserver();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lights the topmost section in view, and the next one once it scrolls away", () => {
    render(<Page />);
    // The stub reports every section as in view when it is first watched.
    expect(readActive()).toBe("machines");

    report(screen.getByTestId("machines"), false);
    expect(readActive()).toBe("software");

    report(screen.getByTestId("machines"), true);
    expect(readActive()).toBe("machines");
  });

  it("keeps the last section lit while none is in view", () => {
    render(<Page />);
    report(screen.getByTestId("machines"), false);
    report(screen.getByTestId("software"), false);
    expect(readActive()).toBe("software");
  });

  it("follows the sections it is given", () => {
    const { rerender } = render(<Page ids={["capacity", "running"]} />);
    expect(readActive()).toBe("capacity");

    rerender(<Page ids={["running"]} />);
    expect(readActive()).toBe("running");
  });

  it("stops watching the sections when the page goes", () => {
    const { unmount } = render(<Page />);
    const section = screen.getByTestId("machines");
    unmount();
    // A report for a section that is no longer watched changes nothing and does not throw.
    expect(() => report(section, false)).not.toThrow();
  });

  describe("scrolling to a section", () => {
    const scrollIntoView = vi.fn();
    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    it("scrolls smoothly to the section's top", () => {
      render(<Page />);
      act(() => screen.getByRole("button", { name: "Jump to software" }).click());
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId("software"));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    });

    it("jumps without animation while Reduce motion is on", () => {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query) => ({ matches: true, media: query }) as MediaQueryList,
      );
      render(<Page />);
      act(() => screen.getByRole("button", { name: "Jump to software" }).click());
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    });
  });
});
