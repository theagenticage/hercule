/**
 * The reference sheet: every cell of `cells.ts`, drawn with the Bureau
 * book's own crew.js. `pnpm compare:bureau` compares it pixel for pixel with
 * the app's specimen sheet, which draws the same cells with the app's
 * components.
 *
 * crew.js returns each piece as a string of markup, so this is the one file
 * in the renderer that may set `innerHTML`. The markup is the book's own,
 * from the copy in docs/design/crew-bureau that is kept unedited.
 */
import "./sheet.css";
import { SHEET, type IconName, type Piece } from "./cells";
import { applySheetTheme, markSheetReady, readCrew } from "./sheet-page";

const crew = readCrew();

// The icons the book names differently from the app. Every other icon has the same name in both.
const BOOK_ICON_NAMES: Partial<Record<IconName, string>> = {
  "chevron-right": "chev-r",
  workspace: "worktree",
};

/** Returns the book's markup for one cell's piece. */
function drawPiece(piece: Piece): string {
  switch (piece.kind) {
    case "face": {
      const { hue, shape, accessories } = piece.look;
      // The book spells a wardrobe entry as its accessories joined by "+", or "none".
      const look = { hue, shape, acc: accessories.join("+") || "none" };
      return crew.face("Specimen", { pose: piece.pose, size: piece.size, look });
    }
    case "seeded-face":
      // With no look given, the book computes one from the name with its `lookFor`.
      return crew.face(piece.seed, { pose: "idle", size: piece.size });
    case "avatar":
      return crew.you(piece.size);
    case "mark":
      return crew.mark(piece.state, 14);
    case "icon":
      return crew.icon(BOOK_ICON_NAMES[piece.icon] ?? piece.icon, piece.size);
  }
}

applySheetTheme();
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
