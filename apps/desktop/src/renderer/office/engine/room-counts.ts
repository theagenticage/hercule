/**
 * How many colleagues each room of the Office counts. A room's label in the
 * 3D view and its row in the Rooms directory both read these counts, so the
 * two always show the same number.
 */
import type { ColleagueState, RoomInfo, Seat } from "./contracts";

/** The counts a room shows. */
interface RoomCount {
  /** How many colleagues belong in the room now. */
  readonly colleagues: number;
  /** How many of those colleagues wait on the user. */
  readonly waiting: number;
}

/** Returns true when a colleague in `state` waits on the user. */
export const isWaiting = (state: ColleagueState): boolean =>
  state.pose === "waiting" || state.request !== null;

/**
 * Returns the counts of every room in `rooms`, by room id. `homes` holds each
 * colleague's seat, by colleague id, and `states` each colleague's state.
 * - The Lounge counts the idle colleagues whose seat is in a project room,
 *   because those colleagues, the threads, rest there. An idle assistant
 *   stays at its desk in the Secretariat.
 * - Your Office counts every colleague who waits on the user, thread or
 *   assistant, because they queue there.
 * - Any other room, such as a project room or the Secretariat, counts the
 *   colleagues whose seat is in it. A room with no seats, such as the Lobby,
 *   counts nought.
 *
 * A room counts by who belongs in it, not by who stands in it: a colleague
 * walking through a room does not change its count.
 */
export function countColleaguesByRoom(
  rooms: ReadonlyArray<RoomInfo>,
  homes: ReadonlyMap<string, Seat>,
  states: ReadonlyMap<string, ColleagueState>,
): ReadonlyMap<string, RoomCount> {
  const kinds = new Map(rooms.map((room) => [room.id, room.kind]));
  const seated = new Map<string, { colleagues: number; waiting: number }>();
  let idle = 0;
  for (const [colleagueId, seat] of homes) {
    const count = seated.get(seat.roomId) ?? { colleagues: 0, waiting: 0 };
    count.colleagues += 1;
    const state = states.get(colleagueId);
    if (state !== undefined && isWaiting(state)) count.waiting += 1;
    if (state?.pose === "idle" && kinds.get(seat.roomId) === "project") idle += 1;
    seated.set(seat.roomId, count);
  }
  const waiting = [...states.values()].filter(isWaiting).length;

  const counts = new Map<string, RoomCount>();
  for (const room of rooms) {
    const count: RoomCount =
      room.kind === "lounge"
        ? { colleagues: idle, waiting: 0 }
        : room.kind === "your-office"
          ? { colleagues: waiting, waiting }
          : (seated.get(room.id) ?? { colleagues: 0, waiting: 0 });
    counts.set(room.id, count);
  }
  return counts;
}
