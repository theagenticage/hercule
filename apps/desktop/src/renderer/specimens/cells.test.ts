import { expect, it } from "vitest";
import * as icons from "../icons";
import { SHEET } from "./cells";

/**
 * The icons the app names apart from the frozen book, by the app's export
 * name, with the book's name, which the sheet's cell keeps: the book drew the
 * Inbox's tray for Intake, which the Inbox replaced (#1243).
 */
const BOOK_ICON_NAMES: Readonly<Record<string, string>> = { InboxIcon: "intake" };

// `pnpm compare:bureau` proves only the icons the sheet draws, so an icon
// added to the app without a cell would ship unchecked.
it("draws every icon the app exports at 16", () => {
  const drawn = new Set(SHEET.flat().map(({ name }) => name));
  const undrawn = Object.keys(icons)
    .filter((name) => name !== "IconFrame")
    // `ChevronRightIcon` is the cell `icon/chevron-right/16`.
    .map((name) => {
      const words =
        BOOK_ICON_NAMES[name] ?? name.slice(0, -"Icon".length).replace(/(?<=.)(?=[A-Z])/g, "-");
      return `icon/${words.toLowerCase()}/16`;
    })
    .filter((cell) => !drawn.has(cell));
  expect(undrawn).toEqual([]);
});
