import { expect, it } from "vitest";
import * as icons from "../icons";
import { SHEET } from "./cells";

// PROTOTYPE. The icons the Workflows page proposes to add to the Bureau
// book. The sheet cannot draw them until the book's crew.js does, so each
// one ships unchecked until the book takes it and this list loses it.
const NOT_IN_THE_BOOK_YET = new Set(["AgentIcon", "MinusIcon"]);

// `pnpm compare:bureau` proves only the icons the sheet draws, so an icon
// added to the app without a cell would ship unchecked.
it("draws every icon the app exports at 16", () => {
  const drawn = new Set(SHEET.flat().map(({ name }) => name));
  const undrawn = Object.keys(icons)
    .filter((name) => name !== "IconFrame" && !NOT_IN_THE_BOOK_YET.has(name))
    // `ChevronRightIcon` is the cell `icon/chevron-right/16`.
    .map((name) => {
      const words = name.slice(0, -"Icon".length).replace(/(?<=.)(?=[A-Z])/g, "-");
      return `icon/${words.toLowerCase()}/16`;
    })
    .filter((cell) => !drawn.has(cell));
  expect(undrawn).toEqual([]);
});
