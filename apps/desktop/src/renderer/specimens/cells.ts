/**
 * The cells of the two specimen sheets: what each cell draws, and where.
 *
 * `pnpm compare:bureau` draws every cell twice: once with the app's own
 * components (`specimens.tsx`) and once with the Bureau book's crew.js
 * (`reference.ts`). It then compares the two captures pixel for pixel. This
 * file is plain data, so both sheets are sure to draw the same list.
 *
 * The sheet is a stack of rows, and each row is a line of cells. A cell's
 * name says what it draws, such as `face/waiting/22` or `icon/plus/14`; the
 * tool reports differences by that name.
 */
import { POSES, type Pose } from "@hercule/client-core";
import { HUES, SHAPES, WARDROBE, type Look } from "../faces";
import type { MarkState } from "../marks";

/**
 * An icon, by the name of its component: `plus` is `PlusIcon`. The Bureau
 * book's crew.js uses the same names, except that it calls `workspace`
 * `worktree` and `chevron-right` `chev-r`.
 */
export type IconName =
  | "bound"
  | "branch"
  | "chat"
  | "check"
  | "chevron-right"
  | "clock"
  | "close"
  | "compose"
  | "connections"
  | "cpu"
  | "crew"
  | "editor"
  | "external"
  | "eye"
  | "file"
  | "fleet"
  | "globe"
  | "heart"
  | "id"
  | "intake"
  | "key"
  | "laptop"
  | "list"
  | "mic"
  | "moon"
  | "more"
  | "office"
  | "palette"
  | "pause"
  | "plus"
  | "puzzle"
  | "question"
  | "search"
  | "send"
  | "server"
  | "shield"
  | "sidebar"
  | "sliders"
  | "sparkle"
  | "stop"
  | "sun"
  | "system"
  | "tasks"
  | "terminal"
  | "threads"
  | "undo"
  | "user"
  | "workspace";

/** What one cell draws. */
export type Piece =
  /** A face with a given look. */
  | { readonly kind: "face"; readonly look: Look; readonly pose: Pose; readonly size: number }
  /** An idle face whose look each side computes from `seed`: the app with `buildLook`, the book with `lookFor`. */
  | { readonly kind: "seeded-face"; readonly seed: string; readonly size: number }
  /** The user's avatar. */
  | { readonly kind: "avatar"; readonly size: number }
  /** A state mark at its default size, 14. */
  | { readonly kind: "mark"; readonly state: MarkState }
  | { readonly kind: "icon"; readonly icon: IconName; readonly size: number };

/** One cell of the sheet: its name and what it draws. */
export interface Cell {
  readonly name: string;
  readonly piece: Piece;
}

// The six marks, in the order the book lists them.
const MARK_STATES: ReadonlyArray<MarkState> = [
  "working",
  "waiting",
  "done",
  "failed",
  "paused",
  "idle",
];

// Every icon, with each size other than 16 that the v1 desktop pages draw it
// at. The sheet draws every icon at 16, and again at each of these sizes.
const ICONS: ReadonlyArray<readonly [IconName, ReadonlyArray<number>]> = [
  ["bound", []],
  ["branch", [13, 14]],
  ["chat", [13]],
  ["check", [12, 14]],
  ["chevron-right", [13]],
  ["clock", [14]],
  ["close", [12]],
  ["compose", [14]],
  ["connections", []],
  ["cpu", []],
  ["crew", []],
  ["editor", []],
  ["external", [12, 14]],
  ["eye", [14]],
  ["file", [12, 14]],
  ["fleet", []],
  ["globe", [12]],
  ["heart", [15]],
  ["id", []],
  ["intake", [13, 14]],
  ["key", [14]],
  ["laptop", [13]],
  ["list", [14]],
  ["mic", []],
  ["moon", [14]],
  ["more", []],
  ["office", []],
  ["palette", []],
  ["pause", [12, 14]],
  ["plus", [14]],
  ["puzzle", []],
  ["question", [14]],
  ["search", [14]],
  ["send", []],
  ["server", [14]],
  ["shield", [14]],
  ["sidebar", []],
  ["sliders", [14]],
  ["sparkle", [14]],
  ["stop", [14]],
  ["sun", [14]],
  ["system", []],
  ["tasks", [14]],
  ["terminal", [12]],
  ["threads", []],
  ["undo", [15]],
  ["user", []],
  ["workspace", [13, 14, 18, 20]],
];

/** Every icon at 16, in one list the sheet splits into two rows. */
const ICONS_AT_16 = ICONS.map(([icon]) => buildIconCell(icon, 16));

/** Every icon at each of its sizes other than 16, in one list the sheet splits into two rows. */
const SIZED_ICONS = ICONS.flatMap(([icon, sizes]) =>
  sizes.map((size) => buildIconCell(icon, size)),
);

// Session ids as the controller makes them: UUIDv7 strings.
const SEEDS = [
  "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60",
  "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61",
  "0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa",
];

/** Builds the cells of the eight poses of one look at one size, named `face/<prefix><pose>/<size>`. */
function buildPoseCells(prefix: string, look: Look, size: number): ReadonlyArray<Cell> {
  return POSES.map((pose) => ({
    name: `face/${prefix}${pose}/${String(size)}`,
    piece: { kind: "face", look, pose, size },
  }));
}

/**
 * Builds the cells of the idle face at 34 of each wardrobe entry in each shape, named
 * `face/<wardrobe>/<shape>`, such as `face/tache+bowtie/wide`. The hue moves
 * one step along the wheel with each cell, so each hue shows four times.
 */
function buildWardrobeCells(): ReadonlyArray<Cell> {
  return WARDROBE.flatMap((accessories, entry) =>
    SHAPES.map((shape, index) => ({
      name: `face/${accessories.join("+") || "none"}/${shape}`,
      piece: {
        kind: "face",
        look: { hue: HUES[(entry * SHAPES.length + index) % HUES.length]!, shape, accessories },
        pose: "idle",
        size: 34,
      },
    })),
  );
}

/** Builds the cell of one icon at one size, named `icon/<name>/<size>`. */
function buildIconCell(icon: IconName, size: number): Cell {
  return { name: `icon/${icon}/${String(size)}`, piece: { kind: "icon", icon, size } };
}

const PLAIN: Look = { hue: "iris", shape: "egg", accessories: [] };
const TACHE: Look = { hue: "iris", shape: "egg", accessories: ["tache"] };
const wardrobe = buildWardrobeCells();

/** The sheet, row by row. It fits the 1440 × 900 window with room to spare. */
export const SHEET: ReadonlyArray<ReadonlyArray<Cell>> = [
  buildPoseCells("", PLAIN, 22),
  buildPoseCells("", PLAIN, 24),
  buildPoseCells("", PLAIN, 30),
  buildPoseCells("", PLAIN, 34),
  buildPoseCells("", PLAIN, 68),
  wardrobe.slice(0, wardrobe.length / 2),
  wardrobe.slice(wardrobe.length / 2),
  [...buildPoseCells("tache/", TACHE, 22), ...buildPoseCells("tache/", TACHE, 34)],
  [
    ...SEEDS.map((seed): Cell => ({
      name: `face/seed/${seed}`,
      piece: { kind: "seeded-face", seed, size: 34 },
    })),
    { name: "avatar/24", piece: { kind: "avatar", size: 24 } },
    { name: "avatar/28", piece: { kind: "avatar", size: 28 } },
  ],
  [
    ...MARK_STATES.map((state): Cell => ({
      name: `mark/${state}`,
      piece: { kind: "mark", state },
    })),
    ...ICONS_AT_16.slice(0, Math.ceil(ICONS_AT_16.length / 2)),
  ],
  ICONS_AT_16.slice(Math.ceil(ICONS_AT_16.length / 2)),
  SIZED_ICONS.slice(0, Math.ceil(SIZED_ICONS.length / 2)),
  SIZED_ICONS.slice(Math.ceil(SIZED_ICONS.length / 2)),
];
