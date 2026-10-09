/**
 * The Office Map type, and the Bureau: for now the only Office Map.
 *
 * An Office Map is a plain typed value. `maps/bureau-rooms.ts` reads only
 * its fixed rooms and its annex: which exist, in what order, under what
 * name, which furniture stands in them, and which spots they offer to
 * colleagues. The other fields describe what the code does anyway:
 *
 * - `growth`, `wing`, `room` and `desk` each allow one value, the one the
 *   code implements;
 * - `id` and `name` are not read.
 *
 * The code owns each room's geometry, the growth rule itself and the
 * animations. Left for later (#336): a real map format with its own schema,
 * growth rules the map spells out instead of naming one the code knows, maps
 * other than the Bureau, and importing maps.
 */

/** A piece of furniture the code knows how to build and place. */
export type Furniture =
  | "clerks-desk"
  | "partner-desk"
  | "case-board"
  | "armchairs"
  | "tea-trolley"
  | "bench"
  | "now-serving"
  | "coat-stand"
  | "directory"
  | "wall-clock"
  | "writing-desks"
  | "bookcases"
  | "longcase-clock"
  | "plant"
  | "lamp";

/**
 * A place a fixed room offers a colleague:
 *
 * - `seat`: somewhere to sit, such as the Lounge's armchairs;
 * - `stand`: somewhere to stand, such as the tea trolley or the front door;
 * - `queue`: the line in front of the user's desk.
 */
export type SpotKind = "seat" | "stand" | "queue";

/**
 * The kinds of fixed room the code can build. Each has its geometry in code.
 * A map holds at most one room of each kind, so a fixed room's kind is also
 * its room id.
 */
export type FixedRoomKind = "triage-room" | "lounge" | "your-office" | "secretariat" | "lobby";

/** A room every Office has, whatever threads it seats. */
export interface FixedRoom {
  readonly kind: FixedRoomKind;
  /** The name on the room's plaque and in the room directory. */
  readonly name: string;
  readonly furniture: ReadonlyArray<Furniture>;
  readonly spots: ReadonlyArray<SpotKind>;
}

/**
 * The description an Office is built from: its fixed rooms and their
 * furniture, what a wing and a room stand for, and the named rule by which
 * the place grows as threads arrive. The Office stays one view whatever its
 * map: a bureau, a tower and a cave would be three maps that seat the same
 * threads in different places.
 */
export interface OfficeMap {
  readonly id: string;
  readonly name: string;
  /**
   * The rule by which the place grows. `gallery-wings` lays the thread rooms
   * in wings along a corridor north of the Gallery, the fixed rooms along
   * the street south of it, and the annex south of its room, toward the
   * street; the rule's geometry is `maps/bureau-plan.ts`.
   */
  readonly growth: "gallery-wings";
  /** What a wing stands for. `none`: wings carry no meaning, and rooms fill them in order. */
  readonly wing: "none";
  /** What a room stands for. `project`: one room per project, and one for the threads with none. */
  readonly room: "project";
  /** What stands at each thread's desk. */
  readonly desk: "clerks-desk";
  /** The fixed rooms, west to east along the street. The last one holds the front door. */
  readonly fixedRooms: ReadonlyArray<FixedRoom>;
  /**
   * The fixed room south of the street-row room of kind `southOf`, or null.
   * It stands between that room and the street, as wide as it, and is
   * entered only through it.
   */
  readonly annex: { readonly room: FixedRoom; readonly southOf: FixedRoomKind } | null;
}

/**
 * The Bureau: thread rooms in wings north of the Gallery, fixed rooms along
 * the street south of it, and the Secretariat south of Your Office.
 */
export const BUREAU_MAP: OfficeMap = {
  id: "bureau",
  name: "Bureau",
  growth: "gallery-wings",
  wing: "none",
  room: "project",
  desk: "clerks-desk",
  fixedRooms: [
    {
      kind: "triage-room",
      name: "The Triage Room",
      // Triage's desk stays empty: no Triage character is drawn yet.
      furniture: ["clerks-desk", "case-board", "plant", "lamp"],
      spots: [],
    },
    {
      kind: "lounge",
      name: "The Lounge",
      furniture: ["armchairs", "tea-trolley", "plant", "lamp"],
      spots: ["seat", "stand"],
    },
    {
      kind: "your-office",
      name: "Your Office",
      furniture: [
        "partner-desk",
        "now-serving",
        "bench",
        "armchairs",
        "wall-clock",
        "plant",
        "lamp",
      ],
      spots: ["seat", "queue"],
    },
    {
      kind: "lobby",
      name: "The Lobby",
      furniture: ["coat-stand", "bench", "directory", "armchairs", "wall-clock", "plant", "lamp"],
      spots: ["stand"],
    },
  ],
  annex: {
    room: {
      kind: "secretariat",
      name: "The Secretariat",
      // Each assistant's corner holds a writing desk, an armchair and a bookcase.
      furniture: ["writing-desks", "armchairs", "bookcases", "longcase-clock", "plant", "lamp"],
      spots: ["seat"],
    },
    southOf: "your-office",
  },
};
