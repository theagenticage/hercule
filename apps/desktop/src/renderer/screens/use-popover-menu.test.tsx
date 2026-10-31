/**
 * Tests that a popover menu draws active the item with the focus, however
 * the focus got there, so Enter takes the item the user sees highlighted.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { usePopoverMenu } from "./use-popover-menu";

/**
 * A menu with three items, the second disabled, each calling `onTake` with
 * its name. jsdom has no popover API and would hide a popover from Tab, so
 * the menu is drawn as a plain element, always shown.
 */
function TestMenu({ onTake }: { readonly onTake: (item: string) => void }): JSX.Element {
  const { triggerProps, menuProps, buildItemProps } = usePopoverMenu();
  return (
    <>
      <button type="button" {...triggerProps}>
        Open
      </button>
      <div {...menuProps} role="menu" aria-label="Open">
        {(["first", "second", "third"] as const).map((item) => (
          <button
            key={item}
            type="button"
            {...buildItemProps(item, { disabled: item === "second" })}
            onClick={() => {
              onTake(item);
            }}
          >
            {item}
          </button>
        ))}
      </div>
    </>
  );
}

/** Returns the item named `name`. */
const getItem = (name: string): HTMLElement => screen.getByRole("menuitem", { name });

/** Returns the names of the items drawn active. */
const listActiveItems = (): Array<string> =>
  [...document.querySelectorAll(".is-active")].map((item) => item.textContent ?? "");

describe("usePopoverMenu", () => {
  it("marks its trigger as opening a menu", () => {
    render(<TestMenu onTake={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Open" }).getAttribute("aria-haspopup")).toBe("menu");
  });

  it("moves the highlight with Tab, and Enter takes the highlighted item", async () => {
    const onTake = vi.fn();
    render(<TestMenu onTake={onTake} />);
    act(() => {
      getItem("first").focus();
    });
    expect(listActiveItems()).toEqual(["first"]);

    await userEvent.tab();
    // The disabled item takes the focus but is never drawn active.
    expect(document.activeElement).toBe(getItem("second"));
    expect(listActiveItems()).toEqual([]);
    await userEvent.tab();
    expect(listActiveItems()).toEqual(["third"]);
    await userEvent.keyboard("{Enter}");

    expect(onTake).toHaveBeenCalledExactlyOnceWith("third");
  });

  it("moves the focus to the item under the pointer, so the highlight never splits", async () => {
    const onTake = vi.fn();
    render(<TestMenu onTake={onTake} />);
    act(() => {
      getItem("first").focus();
    });

    await userEvent.hover(getItem("third"));

    expect(document.activeElement).toBe(getItem("third"));
    expect(listActiveItems()).toEqual(["third"]);
    await userEvent.keyboard("{Enter}");
    expect(onTake).toHaveBeenCalledExactlyOnceWith("third");
  });

  it("moves the highlight with the arrow keys, passing over a disabled item", async () => {
    render(<TestMenu onTake={vi.fn()} />);
    act(() => {
      getItem("first").focus();
    });

    await userEvent.keyboard("{ArrowDown}");

    expect(listActiveItems()).toEqual(["third"]);
  });

  it("gives an item that is one of a group of choices the role of a radio item", () => {
    function ChoiceMenu(): JSX.Element {
      const { menuProps, buildItemProps } = usePopoverMenu();
      return (
        <div {...menuProps} role="menu" aria-label="Choices">
          <button type="button" {...buildItemProps("on", { checked: true })}>
            on
          </button>
          <button type="button" {...buildItemProps("off", { checked: false })}>
            off
          </button>
          <button type="button" {...buildItemProps("plain")}>
            plain
          </button>
        </div>
      );
    }
    render(<ChoiceMenu />);

    expect(screen.getByRole("menuitemradio", { name: "on", checked: true })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "off", checked: false })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "plain" }).getAttribute("aria-checked")).toBeNull();
  });
});
