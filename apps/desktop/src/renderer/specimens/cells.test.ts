import { expect, it } from "vitest";
import * as icons from "../icons";
import { SHEET } from "./cells";

// `pnpm compare:bureau` proves only the icons the sheet draws, so an icon
// added to the app without a cell would ship unchecked.
it("draws every icon the app exports at 16", () => {
  const drawn = new Set(SHEET.flat().map(({ name }) => name));
  const undrawn = Object.keys(icons)
    .filter((name) => name !== "IconFrame")
    // `ChevronRightIcon` is the cell `icon/chevron-right/16`.
    .map((name) => {
      const words = name.slice(0, -"Icon".length).replace(/(?<=.)(?=[A-Z])/g, "-");
      return `icon/${words.toLowerCase()}/16`;
    })
    .filter((cell) => !drawn.has(cell));
  expect(undrawn).toEqual([]);
});
