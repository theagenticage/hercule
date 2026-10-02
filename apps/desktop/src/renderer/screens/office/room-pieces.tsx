import type { JSX, ReactNode } from "react";
import { buildLook } from "../../faces";
import { GitHubMark } from "../../logos";
import type { ProjectTint } from "../project-tile";
import {
  drawClubChair,
  drawColleague,
  drawDesk,
  drawHatStand,
  drawPalm,
  drawSideboard,
  drawSideTable,
  drawYourDesk,
  measureFaceSize,
} from "./furniture";
import type { Projection } from "./projection";
import { drawTubeToDesk, drawWingField, TUBE_Y } from "./room-shell";

/**
 * What stands in the Office. Every field reads from state the controller
 * already holds, so the room can be drawn again on any later visit.
 */
export interface RoomContents {
  /** False while no controller has answered: the room is drawn dimmed. */
  readonly lightsOn: boolean;
  /** The first runner's wing, or `null` while no runner is known. */
  readonly wing: RoomWing | null;
  /** Whether your desk and its hat stand stand in the room: there is a user. */
  readonly yourDesk: boolean;
  /** The assistant asleep in the lobby's club chair, or `null` for none. */
  readonly assistant: { readonly name: string } | null;
  /** The Triage desk in the back corner, or `null` before Triage is set up. */
  readonly triage: { readonly note: string } | null;
  /**
   * The account GitHub is connected as, such as "rogier", or `null` without a
   * GitHub Connection. With one, the GitHub plaque hangs on the wall and a
   * tube runs from it to the Triage desk.
   */
  readonly gitHubAccount: string | null;
}

/** A runner's wing: an inlaid field on the floor with one desk per session it can host. */
export interface RoomWing {
  /** The runner's name, engraved in the floor. */
  readonly runnerName: string;
  /** The words engraved after the name, such as "this Mac · 6 desks", or "" for none. */
  readonly note: string;
  /** How many desks to set out. The wing has room for 8, so it draws at most 8. */
  readonly deskCount: number;
  /** The first thread, seated at a desk of the wing in its project's tint, or `null` for none. */
  readonly firstThread: { readonly projectName: string; readonly tint: ProjectTint } | null;
}

/** A label over the room: an HTML pill pinned above a plan point. */
export interface RoomLabel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The label's variant class, if any: `tag--quiet` or `tag--you`. */
  readonly variant: "tag--quiet" | "tag--you" | null;
  readonly content: ReactNode;
}

/**
 * One piece of furniture, or a colleague at it. Pieces are drawn in order of
 * `depth`, the farthest first, so a nearer piece covers a farther one.
 */
export interface RoomPiece {
  /** Names the piece. A piece whose key the last drawing lacked arrives. */
  readonly key: string;
  readonly depth: number;
  /** Whether the piece is a colleague: a colleague settles with a spring. */
  readonly character: boolean;
  /** Draws the piece under a projection, or `null` for a piece that is only a label. */
  readonly draw: (p: Projection) => JSX.Element | null;
  /** Places the piece's labels under a projection. */
  readonly label: (p: Projection) => RoomLabel | null;
}

/**
 * The first wing, as the Office plans it: its field on the floor, the columns
 * and rows of its desks, the sideways shift of its front row, and where the
 * runner's name is engraved.
 */
const WING = {
  x: 9.4,
  y: 0.9,
  w: 14.0,
  d: 6.3,
  cols: [11.2, 14.2, 17.2, 20.2],
  rows: [2.4, 5.8],
  stagger: 1.8,
  label: [9.9, 7.75],
} as const;

/** The most desks the wing has room for: two rows of four. */
const MAX_DESKS = WING.cols.length * WING.rows.length;

/** The seat the first thread takes: the front row's first, nearest to you, where nothing hides it. */
const FIRST_THREAD_SEAT = 4;

/** Returns where the `index`-th desk of the wing stands: the back row from left to right, then the front row. */
function placeSeat(index: number): { readonly x: number; readonly y: number } {
  const row = index < WING.cols.length ? 0 : 1;
  return { x: WING.cols[index % WING.cols.length]! + (row ? WING.stagger : 0), y: WING.rows[row] };
}

/**
 * Returns the seat the first thread takes in a wing of `deskCount` desks: the
 * front row's first desk, or the last desk when the wing has no front row.
 */
const pickFirstThreadSeat = (deskCount: number): number =>
  Math.min(FIRST_THREAD_SEAT, deskCount - 1);

/** Returns the height just above a seated colleague's head, in tiles, for its label. */
const measureHeadHeight = (p: Projection, seatHeight: number): number =>
  seatHeight + (measureFaceSize(p) * 0.9) / p.tile;

/** Returns a label's name and its note, as the book writes them: `<b>name</b><span>note</span>`. */
function writeLabel(name: string, note?: string): ReactNode {
  return (
    <>
      <b>{name}</b>
      {note !== undefined && <span>{note}</span>}
    </>
  );
}

/**
 * Returns the pieces `contents` puts in the room, in the order the book's
 * first run lists them. The sideboard and the palms are always there.
 */
export function furnishRoom(contents: RoomContents): RoomPiece[] {
  const pieces: RoomPiece[] = [];
  const add = (piece: Omit<RoomPiece, "character" | "label"> & Partial<RoomPiece>) => {
    pieces.push({ character: false, label: () => null, ...piece });
  };

  add({
    key: "dress",
    depth: 1.4,
    draw: (p) => (
      <>
        {drawSideboard(p, 19.6, 2.2)}
        {drawPalm(p, 22.9, 0.5, true)}
      </>
    ),
  });
  add({ key: "palm-r", depth: 38.7, draw: (p) => drawPalm(p, 23.1, 15.4, true) });
  add({ key: "palm-l", depth: 18.2, draw: (p) => drawPalm(p, 0.25, 17.7, false) });

  const { wing } = contents;
  if (wing !== null) {
    add({
      key: "wing",
      depth: -100,
      draw: (p) => drawWingField(p, WING, WING.label, wing.runnerName, wing.note),
    });
  }

  if (contents.yourDesk) {
    add({
      key: "you",
      depth: 3.0 + 15.8,
      draw: (p) => (
        <>
          {drawYourDesk(p, 1.4, 15.8)}
          {drawHatStand(p, 0.6, 14.8)}
        </>
      ),
      label: () => ({
        x: 2.9,
        y: 16.4,
        z: 1.62,
        variant: "tag--you",
        content: writeLabel("Your desk"),
      }),
    });
  }

  const { assistant } = contents;
  if (assistant !== null) {
    add({
      key: "assistant",
      depth: 21.4 + 16.9,
      character: true,
      draw: (p) => (
        <>
          {drawSideTable(p, 20.0, 17.7)}
          {drawClubChair(p, 21.4, 16.9, buildLook(assistant.name))}
        </>
      ),
      label: (p) => ({
        x: 21.4,
        y: 16.9,
        z: measureHeadHeight(p, 0.38),
        variant: "tag--quiet",
        content: writeLabel(assistant.name, "your assistant"),
      }),
    });
  }

  if (wing !== null) {
    const deskCount = Math.min(wing.deskCount, MAX_DESKS);
    const threadSeat = pickFirstThreadSeat(deskCount);
    for (let index = 0; index < deskCount; index++) {
      const seat = placeSeat(index);
      const tint = index === threadSeat ? (wing.firstThread?.tint ?? null) : null;
      add({
        key: `desk-${index}`,
        depth: seat.x + seat.y,
        draw: (p) => drawDesk(p, { ...seat, tint, colleague: null }),
      });
    }
    const { firstThread } = wing;
    if (firstThread !== null && deskCount > 0) {
      const seat = placeSeat(threadSeat);
      add({
        key: "thread",
        depth: seat.x + seat.y + 0.01,
        character: true,
        draw: (p) =>
          drawColleague(
            p,
            buildLook(`New thread in ${firstThread.projectName}`),
            "idle",
            seat.x,
            seat.y,
            0.42,
          ),
        label: (p) => ({
          x: seat.x,
          y: seat.y,
          z: measureHeadHeight(p, 0.42),
          variant: null,
          content: writeLabel("New thread", firstThread.projectName),
        }),
      });
    }
  }

  const { triage, gitHubAccount } = contents;
  if (triage !== null) {
    const seat = { x: 3.5, y: TUBE_Y };
    const tube = gitHubAccount !== null;
    add({
      // A new key once the tube is fitted, so the desk arrives again with it.
      key: tube ? "triage+github" : "triage",
      depth: seat.x + seat.y,
      character: true,
      draw: (p) =>
        drawDesk(
          p,
          { ...seat, tint: null, colleague: buildLook("Triage") },
          tube ? drawTubeToDesk(p, seat.x - 1.2) : undefined,
        ),
      label: (p) => ({
        ...seat,
        z: measureHeadHeight(p, 0.42),
        variant: null,
        content: writeLabel("Triage", triage.note),
      }),
    });
  }

  if (gitHubAccount !== null) {
    add({
      key: "plaque",
      depth: -50,
      draw: () => null,
      label: () => ({
        x: 0.02,
        y: 4.72,
        z: 3.38,
        variant: "tag--quiet",
        content: (
          <>
            <GitHubMark size={12} />
            {writeLabel("GitHub", gitHubAccount)}
          </>
        ),
      }),
    });
  }

  return pieces;
}
