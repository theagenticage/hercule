/**
 * The room directory: a menu in the top bar listing every room of the
 * Office, so the user can fly the camera straight to one.
 *
 * The rooms come from the scene's current layout, read each time the menu
 * opens, so the list follows the rooms as threads come and go. The project
 * rooms come first, each drawn as its project's tile, then the Office's
 * fixed rooms. Each room shows how many colleagues belong in it now: see
 * `countColleaguesByRoom`.
 */
import { useSyncExternalStore, type JSX } from "react";
import { ProjectTile } from "../../screens/project-tile";
import type { ColleagueState, OfficeLayout, RoomInfo } from "../engine/contracts";
import type { OfficeScene } from "../office-scene";
import {
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import type { Pose } from "../world/types";
import { ListIcon } from "../../icons/list";
import { ChevronDownIcon } from "./office-icons";
import { OfficeMenu } from "./office-menu";

/** One heading of the directory and its rooms. */
interface RoomGroup {
  readonly heading: string;
  readonly rooms: ReadonlyArray<RoomInfo>;
}

/**
 * Returns the rooms of `rooms` in the directory's groups: the project rooms
 * under "Projects", then every other room under "The office", each in the
 * layout's order. Groups with no rooms are left out.
 */
export function groupRooms(rooms: ReadonlyArray<RoomInfo>): ReadonlyArray<RoomGroup> {
  const groups: ReadonlyArray<RoomGroup> = [
    { heading: "Projects", rooms: rooms.filter((room) => room.kind === "project") },
    { heading: "The office", rooms: rooms.filter((room) => room.kind !== "project") },
  ];
  return groups.filter((group) => group.rooms.length > 0);
}

/** Counts the colleagues in `states` whose pose is `pose`. */
const countPose = (states: ReadonlyMap<string, ColleagueState>, pose: Pose): number =>
  [...states.values()].filter((state) => state.pose === pose).length;

/**
 * Returns how many colleagues belong in each room of `layout` now, by room id:
 * - a project room: the colleagues with their desk in it;
 * - the Lounge: the colleagues whose pose in `states` is idle, because idle colleagues sit there;
 * - Your Office: the colleagues whose pose is waiting, because they queue there.
 * Any other room has no count, and the directory shows 0.
 */
const countColleaguesByRoom = (
  layout: OfficeLayout,
  states: ReadonlyMap<string, ColleagueState>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const seat of layout.homes.values()) {
    counts.set(seat.roomId, (counts.get(seat.roomId) ?? 0) + 1);
  }
  for (const room of layout.rooms) {
    if (room.kind === "lounge") counts.set(room.id, countPose(states, "idle"));
    if (room.kind === "your-office") counts.set(room.id, countPose(states, "waiting"));
  }
  return counts;
};

/** Renders the directory's list of rooms, the room the camera is in marked. */
function RoomList({
  layout,
  roomId,
  onPick,
}: {
  readonly layout: OfficeLayout;
  readonly roomId: string | null;
  readonly onPick: (roomId: string) => void;
}): JSX.Element {
  const states = useSyncExternalStore(subscribeColleagueStates, readColleagueStates);
  const counts = countColleaguesByRoom(layout, states);
  return (
    <>
      <div className="pop-h">
        <b>Rooms</b>
        <span>{layout.rooms.length} rooms</span>
      </div>
      {groupRooms(layout.rooms).map((group) => (
        <div className="pop-sec" key={group.heading}>
          <div className="q-h">{group.heading}</div>
          {group.rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={room.id === roomId ? "line is-on" : "line"}
              aria-current={room.id === roomId || undefined}
              onClick={() => onPick(room.id)}
            >
              <span className="grow">
                {room.kind === "project" ? (
                  <ProjectTile tint={room.tint} name={room.label} />
                ) : (
                  <b>{room.label}</b>
                )}
              </span>
              <span className="count" aria-label={`${String(counts.get(room.id) ?? 0)} colleagues`}>
                {counts.get(room.id) ?? 0}
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * Renders the directory's trigger, named for the room the camera is in, and
 * the directory it opens. A click on a room flies the camera there.
 */
export function RoomDirectory({ scene }: { readonly scene: OfficeScene | null }): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const room = scene?.readLayout().rooms.find((each) => each.id === state.roomId);
  return (
    <OfficeMenu
      label="Room directory"
      align="start"
      triggerClassName={room === undefined ? "ptab" : "ptab is-on"}
      triggerLabel={room === undefined ? "Rooms" : `Room: ${room.label}`}
      trigger={
        <>
          <ListIcon size={14} />
          <span className="office-top-label">{room?.label ?? "Rooms"}</span>
          <ChevronDownIcon size={12} />
        </>
      }
    >
      {(close) =>
        scene === null ? null : (
          <RoomList
            layout={scene.readLayout()}
            roomId={state.roomId}
            onPick={(roomId) => {
              sendOfficeCommand({ kind: "focus-room", roomId });
              close();
            }}
          />
        )
      }
    </OfficeMenu>
  );
}
