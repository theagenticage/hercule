/**
 * The reference sheet: every cell of `cells.ts`, drawn with the Bureau
 * book's own crew.js. `pnpm compare:bureau` compares it pixel for pixel with
 * the app's specimen sheet, which draws the same cells with the app's
 * components.
 *
 * crew.js returns each piece as a string of markup, so this is one of the
 * two files in the renderer that may set `innerHTML`, with sheet-page.ts.
 * The markup is the book's own, from its second edition in
 * docs/design/crew-bureau-2.
 */
import "./sheet.css";
import { INTAKE_ICON_OUTLINES, OVERVIEW_ICON_OUTLINES } from "../icons/app-icon-outlines";
import { SHEET, type IconName, type Piece } from "./cells";
import { applySheetAppearance, buildBookLook, markSheetReady, readCrew } from "./sheet-page";

const crew = readCrew();

// The icons the book names differently from the app. Every other icon has the same name in both.
const BOOK_ICON_NAMES: Partial<Record<IconName, string>> = {
  "chevron-left": "chev-l",
  "chevron-right": "chev-r",
  inbox: "intake",
  workspace: "worktree",
};

// The icons the book does not draw, by their outlines in the app.
const APP_ICON_OUTLINES: Partial<Record<IconName, ReadonlyArray<string>>> = {
  intake: INTAKE_ICON_OUTLINES,
  overview: OVERVIEW_ICON_OUTLINES,
};

/**
 * Returns the markup of an icon the book does not draw: its outlines in the
 * svg frame that crew.js's `icon` writes, attribute for attribute. The cell
 * then checks that the app's `IconFrame` draws the outlines as the book's
 * frame does.
 */
function drawAppIcon(outlines: ReadonlyArray<string>, size: number): string {
  const paths = outlines.map((outline) => `<path d="${outline}"/>`).join("");
  return `<svg class="ic" viewBox="0 0 16 16" width="${String(size)}" height="${String(size)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** Returns the book's markup for one cell's piece. */
function drawPiece(piece: Piece): string {
  switch (piece.kind) {
    case "face":
      return crew.face("Specimen", {
        pose: piece.pose,
        size: piece.size,
        look: buildBookLook(piece.look),
      });
    case "seeded-face":
      // With no look given, the book computes one from the name with its `lookFor`.
      return crew.face(piece.seed, { pose: "idle", size: piece.size });
    case "avatar":
      return crew.you(piece.size);
    case "mark":
      return crew.mark(piece.state, 14);
    case "icon": {
      const outlines = APP_ICON_OUTLINES[piece.icon];
      return outlines === undefined
        ? crew.icon(BOOK_ICON_NAMES[piece.icon] ?? piece.icon, piece.size)
        : drawAppIcon(outlines, piece.size);
    }
  }
}

applySheetAppearance();
const sheet = document.getElementById("sheet");
if (sheet === null) {
  throw new Error("specimens/reference.html is missing #sheet");
}
for (const row of SHEET) {
  const rowElement = document.createElement("div");
  rowElement.className = "sheet-row";
  for (const cell of row) {
    const cellElement = document.createElement("div");
    cellElement.dataset.cell = cell.name;
    cellElement.innerHTML = drawPiece(cell.piece);
    rowElement.append(cellElement);
  }
  sheet.append(rowElement);
}
await markSheetReady();
