/**
 * Tests how the keys step through a popover menu: the arrows down and up,
 * wrapping at both ends, Home and End, and passing over a disabled item.
 */
import { afterEach, describe, expect, it } from "vitest";
import { moveMenuFocus } from "./move-menu-focus";

/** Builds a menu with one item per label, adds it to the page and returns it. */
const buildMenu = (
  labels: ReadonlyArray<string>,
  disabled: ReadonlyArray<string> = [],
  role = "menuitem",
) => {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  for (const label of labels) {
    const item = document.createElement("button");
    item.setAttribute("role", role);
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

  it("moves to the first item on Home and the last on End, from anywhere", () => {
    const menu = buildMenu(["One", "Two", "Three"]);
    expect(moveMenuFocus(menu, "End")?.textContent).toBe("Three");
    expect(moveMenuFocus(menu, "End")?.textContent).toBe("Three");
    expect(moveMenuFocus(menu, "Home")?.textContent).toBe("One");
    expect(document.activeElement?.textContent).toBe("One");
  });

  it("passes over a disabled first or last item on Home and End", () => {
    const menu = buildMenu(["One", "Two", "Three", "Four"], ["One", "Four"]);
    expect(moveMenuFocus(menu, "Home")?.textContent).toBe("Two");
    expect(moveMenuFocus(menu, "End")?.textContent).toBe("Three");
  });

  it("steps through the choices of a group of radio items too", () => {
    const menu = buildMenu(["One", "Two"], [], "menuitemradio");
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("One");
    expect(moveMenuFocus(menu, "ArrowDown")?.textContent).toBe("Two");
  });

  it("returns undefined when no item can take the focus", () => {
    const menu = buildMenu(["One"], ["One"]);
    expect(moveMenuFocus(menu, "ArrowDown")).toBeUndefined();
    expect(moveMenuFocus(menu, "Home")).toBeUndefined();
    expect(moveMenuFocus(menu, "End")).toBeUndefined();
  });
});
