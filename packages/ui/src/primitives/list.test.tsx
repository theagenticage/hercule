/**
 * The four primitives a list-with-detail screen is built from. All four are
 * generic: they know nothing about tasks, and nothing here mentions one.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Drawer, Input, ListRow, PriorityGlyph, Textarea } from "../index";

describe("Drawer", () => {
  it("renders nothing at all while closed", () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Details">
        Inside
      </Drawer>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Inside")).toBeNull();
  });

  it("is a dialog named by its title, holding what it was given", () => {
    render(
      <Drawer open onClose={() => {}} title="Details">
        Inside
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog.textContent).toContain("Inside");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Details">
        Inside
      </Drawer>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the page behind it is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Details">
        Inside
      </Drawer>,
    );
    const backdrop = document.querySelector("[data-backdrop]");
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from its own close button", async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Details">
        Inside
      </Drawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("PriorityGlyph", () => {
  const bars = () => [...document.querySelectorAll<HTMLElement>("[data-bar]")];
  const painted = () => bars().filter((bar) => bar.dataset.filled === "true");

  it("is always three bars, of which it paints the ones it was given", () => {
    const { rerender } = render(<PriorityGlyph filled={1} label="low" />);
    expect(bars()).toHaveLength(3);
    expect(painted()).toHaveLength(1);

    rerender(<PriorityGlyph filled={2} label="normal" />);
    expect(bars()).toHaveLength(3);
    expect(painted()).toHaveLength(2);

    rerender(<PriorityGlyph filled={3} label="urgent" />);
    expect(bars()).toHaveLength(3);
    expect(painted()).toHaveLength(3);
  });

  it("carries the name it was given", () => {
    render(<PriorityGlyph filled={2} label="normal priority" />);
    expect(screen.getByLabelText("normal priority")).toBeTruthy();
  });

  it("paints in the grey it was asked for, and in the middle grey by default", () => {
    const { rerender } = render(<PriorityGlyph filled={3} label="urgent" />);
    expect(screen.getByLabelText("urgent").className).toContain("text-muted");

    rerender(<PriorityGlyph filled={3} label="urgent" tone="faint" />);
    expect(screen.getByLabelText("urgent").className).toContain("text-faint");

    rerender(<PriorityGlyph filled={3} label="urgent" tone="ink" />);
    expect(screen.getByLabelText("urgent").className).toContain("text-ink");
  });

  it("says importance in shape and grey, never in colour", () => {
    for (const tone of ["faint", "muted", "ink"] as const) {
      const { unmount } = render(<PriorityGlyph filled={3} label="urgent" tone={tone} />);
      const markup = screen.getByLabelText("urgent").outerHTML;
      expect(markup).not.toMatch(/\b(attn|fail|live|ok)\b/);
      expect(markup).not.toContain("project-");
      unmount();
    }
  });
});

describe("Textarea", () => {
  it("carries what the user types", async () => {
    render(<Textarea aria-label="Description" />);
    const field = screen.getByLabelText("Description");
    await userEvent.type(field, "two lines");
    expect(field).toHaveProperty("value", "two lines");
  });

  it("wears the same border, ground and focus as a single-line field", () => {
    render(
      <>
        <Input aria-label="Title" />
        <Textarea aria-label="Description" />
      </>,
    );
    // The treatment is whatever the input states; the point is that the two
    // fields state the same thing, so a change to one is a change to both.
    const treatment = (element: Element) =>
      element.className.split(" ").filter((name) => /^(border|bg-|focus-visible:)/.test(name));

    const single = treatment(screen.getByLabelText("Title"));
    expect(single.length).toBeGreaterThan(0);
    expect(treatment(screen.getByLabelText("Description"))).toEqual(expect.arrayContaining(single));
  });
});

describe("ListRow", () => {
  it("is a button that never submits a form", () => {
    render(<ListRow>A row</ListRow>);
    expect(screen.getByRole("button", { name: "A row" })).toHaveProperty("type", "button");
  });

  it("reports the press", async () => {
    const onClick = vi.fn();
    render(<ListRow onClick={onClick}>A row</ListRow>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("recedes when it is dimmed, and stands at full strength otherwise", () => {
    const dimmed = /(^|\s)opacity-(66|\[0?\.66])/;
    const { rerender } = render(<ListRow>A row</ListRow>);
    expect(screen.getByRole("button").className).not.toMatch(dimmed);

    rerender(<ListRow dimmed>A row</ListRow>);
    expect(screen.getByRole("button").className).toMatch(dimmed);
  });

  it("says which row is the current one", () => {
    const { rerender } = render(<ListRow>A row</ListRow>);
    expect(screen.getByRole("button").getAttribute("aria-current")).toBeNull();

    rerender(<ListRow selected>A row</ListRow>);
    expect(screen.getByRole("button").getAttribute("aria-current")).toBe("true");
  });
});
