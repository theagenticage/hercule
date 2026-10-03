/**
 * The Office Map the Office is built from: its fixed rooms and their
 * furniture, what a wing and a room stand for, and the named rule by which
 * the place grows as threads arrive (CONTEXT.md, "Office Map").
 *
 * This is version 0.1: a plain value with one map in it, the Bureau. The
 * code still owns the geometry, the growth rule itself and the animations;
 * the map decides which fixed rooms exist, in what order, under what name,
 * which furniture stands in them, which spots they offer to colleagues, and
 * what stands at each desk. `variants/bureau-rooms.ts` reads it.
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

/** The kinds of fixed room the code can build. Each has its geometry in code. */
export type FixedRoomKind = "triage-room" | "lounge" | "your-office" | "lobby";

/** A room every Office has, whatever threads it seats. */
export interface FixedRoom {
  readonly kind: FixedRoomKind;
  /** The name on the room's plaque and in the room directory. */
  readonly name: string;
  readonly furniture: ReadonlyArray<Furniture>;
  readonly spots: ReadonlyArray<SpotKind>;
}

export interface OfficeMap {
  readonly id: string;
  readonly name: string;
  /**
   * The rule by which the place grows. `gallery-wings` lays the thread rooms
   * in wings along a corridor north of the Gallery, and the fixed rooms along
   * the street south of it; the rule's geometry is `variants/bureau-plan.ts`.
   */
  readonly growth: "gallery-wings";
  /** What a wing stands for. `none`: wings carry no meaning, and rooms fill them in order. */
  readonly wing: "none";
  /** What a room stands for. `project`: one room per project, and one for the threads with none. */
  readonly room: "project";
  /** What stands at each thread's desk. */
  readonly desk: ReadonlyArray<Furniture>;
  /** The fixed rooms, west to east along the street. The last one holds the front door. */
  readonly fixedRooms: ReadonlyArray<FixedRoom>;
}

/** The Bureau: the one Office Map of version 0.1. */
export const BUREAU_MAP: OfficeMap = {
  id: "bureau",
  name: "Bureau",
  growth: "gallery-wings",
  wing: "none",
  room: "project",
  desk: ["clerks-desk"],
  fixedRooms: [
    {
      kind: "triage-room",
      name: "The Triage Room",
      // Triage's desk stays empty: no Triage character is drawn yet.
      furniture: ["clerks-desk", "case-board", "plant", "lamp"],
      spots: ["stand"],
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
};
