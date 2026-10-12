/**
 * Tests how the arrow keys step through a popover menu: down and up,
 * wrapping at both ends, and passing over a disabled item.
 */
import { afterEach, describe, expect, it } from "vitest";
import { moveMenuFocus } from "./move-menu-focus";

/** Builds a menu with one item per label, adds it to the page and returns it. */
const buildMenu = (labels: ReadonlyArray<string>, disabled: ReadonlyArray<string> = []) => {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  for (const label of labels) {
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    if (disabled.includes(label)) item.setAttribute("aria-disabled", "true");
    menu.append(item);
  }
  document.body.append(menu);
  return menu;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("moveMenuFocus", () => {
  it("moves the focus down and up, wrapping at both ends", () => {
    const menu = buildMenu(["One", "Two", "Three"]);
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("One");
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("Two");
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("Three");
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("One");
    expect(moveMenuFocus(menu, "ArrowUp")?.textContent).toBe("Three");
    expect(document.activeElement?.textContent).toBe("Three");
  });

  it("focuses the last item on ArrowUp when no item has the focus", () => {
    const menu = buildMenu(["One", "Two", "Three"]);
    expect(moveMenuFocus(menu, "ArrowUp")?.textContent).toBe("Three");
  });

  it("passes over a disabled item", () => {
    const menu = buildMenu(["One", "Two", "Three"], ["Two"]);
    moveMenuFocus(menu, "ArrowDown");
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("Three");
  });

  it("returns undefined when no item can take the focus", () => {
    const menu = buildMenu(["One"], ["One"]);
    expect(moveMenuFocus(menu, "ArrowDown")).toBeUndefined();
  });
});
