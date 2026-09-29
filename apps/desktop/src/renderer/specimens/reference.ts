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
import { SHEET, type Piece } from "./cells";
import { applySheetTheme, markSheetReady } from "./sheet-page";

/** The part of the book's crew.js that the sheet draws with. Each function returns SVG markup. */
interface Crew {
  face(
    name: string,
    opts: { pose: string; size: number; look?: { hue: string; shape: string; acc: string } },
  ): string;
  you(size: number): string;
  mark(state: string, size: number): string;
  icon(name: string, size: number): string;
}

/**
 * Returns the `Crew` object that the book's crew.js sets on `window`. crew.js
 * is a classic script, which reference.html loads before this module. Fails
 * when it has not run.
 */
function readCrew(): Crew {
  const { Crew: crew } = window as Window & { readonly Crew?: Crew };
  if (crew === undefined) {
    throw new Error(
      "The Bureau book's crew.js did not load: reference.html must load /design/crew-bureau/crew.js before this module.",
    );
  }
  return crew;
}

const crew = readCrew();

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
      // The book names the workspace icon `worktree`.
      return crew.icon(piece.icon === "workspace" ? "worktree" : piece.icon, piece.size);
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
