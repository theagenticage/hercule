/**
 * PROTOTYPE - the room directory: a menu in the top bar listing every room
 * of the office, so the user can fly the camera straight to one.
 *
 * The rooms come from the scene's current layout, read each time the menu
 * opens, so a change of variant shows that variant's rooms. The storeys or
 * buildings come first, then the code rooms grouped by project, then the
 * office's other rooms. Each room shows how many colleagues have their desk
 * in it.
 */
import { useSyncExternalStore, type JSX } from "react";
import { ProjectTile } from "../../../screens/project-tile";
import { findFloorRoom, type OfficeLayout, type RoomInfo } from "../engine/contracts";
import type { OfficeScene } from "../office-scene";
import { readOffice, sendOfficeCommand, subscribeOffice } from "../office-store";
import { findProjectTint } from "./dossier-card";
import { ChevronDownIcon, ListIcon } from "./office-icons";
import { OfficeMenu } from "./office-menu";

/** One heading of the directory and its rooms. */
interface RoomGroup {
  /** The project whose code rooms the group holds, or null for a group of the office's own rooms. */
  readonly project: string | null;
  /** The project's name, "Storeys", "Buildings" or "The office". */
  readonly heading: string;
  readonly rooms: ReadonlyArray<RoomInfo>;
}

/**
 * Returns the rooms of `rooms` in the directory's groups:
 * - the rooms of kind "floor", headed "Storeys" in an office of several
 *   storeys and "Buildings" in one of several buildings;
 * - one group per project, holding that project's code rooms, in the order
 *   the projects first appear;
 * - every other room, headed "The office". A code room of no project goes here.
 *
 * Groups with no rooms are left out.
 */
export function groupRooms(rooms: ReadonlyArray<RoomInfo>): ReadonlyArray<RoomGroup> {
  const floors: Array<RoomInfo> = [];
  const byProject = new Map<string, Array<RoomInfo>>();
  const others: Array<RoomInfo> = [];
  for (const room of rooms) {
    if (room.kind === "floor") floors.push(room);
    else if (room.kind !== "code" || room.project === null) others.push(room);
    else byProject.set(room.project, [...(byProject.get(room.project) ?? []), room]);
  }
  const storeyed = new Set(rooms.map((room) => room.floor)).size > 1;
  const groups: ReadonlyArray<RoomGroup> = [
    { project: null, heading: storeyed ? "Storeys" : "Buildings", rooms: floors },
    ...[...byProject].map(([project, projectRooms]) => ({
      project,
      heading: project,
      rooms: projectRooms,
    })),
    { project: null, heading: "The office", rooms: others },
  ];
  return groups.filter((group) => group.rooms.length > 0);
}

/**
 * Returns how many colleagues of `layout` have their desk in each room, by
 * room id. A room of kind "floor" counts the desks in every room it stands
 * for too, so a storey or a building counts everyone who works in it.
 */
const countColleaguesByRoom = (layout: OfficeLayout): ReadonlyMap<string, number> => {
  const floorRooms = new Map(
    layout.rooms.map((room) => [room.id, findFloorRoom(room, layout.rooms)?.id]),
  );
  const counts = new Map<string, number>();
  const count = (roomId: string): void => {
    counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
  };
  for (const seat of layout.homes.values()) {
    count(seat.roomId);
    const floorRoomId = floorRooms.get(seat.roomId);
    if (floorRoomId !== undefined) count(floorRoomId);
  }
  return counts;
};

/**
 * Returns where `room` is, as the directory writes it after the room's name:
 * the label of the "floor" room that stands for it, such as "build-box-1".
 * In an office of several storeys a room outside every "floor" room is named
 * by its storey, such as "ground floor" or "floor 2". Returns null for a
 * "floor" room, and in an office of one storey for a room outside every
 * "floor" room, where the name alone is enough.
 */
const describePlace = (room: RoomInfo, rooms: ReadonlyArray<RoomInfo>): string | null => {
  if (room.kind === "floor") return null;
  const floorRoom = findFloorRoom(room, rooms);
  if (floorRoom !== null) return floorRoom.label;
  if (new Set(rooms.map((each) => each.floor)).size === 1) return null;
  return room.floor === 0 ? "ground floor" : `floor ${String(room.floor)}`;
};

/**
 * Renders the directory's list of rooms, the room the camera is in marked.
 * Each room inside a storey or a building also names it, because rooms in
 * different storeys or buildings share labels, such as each storey's Webshop.
 */
function RoomList({
  layout,
  roomId,
  onPick,
}: {
  readonly layout: OfficeLayout;
  readonly roomId: string | null;
  readonly onPick: (roomId: string) => void;
}): JSX.Element {
  const counts = countColleaguesByRoom(layout);
  return (
    <>
      <div className="pop-h">
        <b>Rooms</b>
        <span>{layout.rooms.length} rooms</span>
      </div>
      {groupRooms(layout.rooms).map((group) => (
        <div className="pop-sec" key={group.heading}>
          <div className="q-h">
            {group.project === null ? (
              group.heading
            ) : (
              <ProjectTile tint={findProjectTint(group.project)} name={group.project} />
            )}
          </div>
          {group.rooms.map((room) => {
            const place = describePlace(room, layout.rooms);
            return (
              <button
                key={room.id}
                type="button"
                className={room.id === roomId ? "line is-on" : "line"}
                aria-current={room.id === roomId || undefined}
                onClick={() => onPick(room.id)}
              >
                <span className="grow">
                  <b>{room.label}</b>
                  {place === null ? null : <span className="faint"> · {place}</span>}
                </span>
                <span
                  className="count"
                  aria-label={`${String(counts.get(room.id) ?? 0)} colleagues`}
                >
                  {counts.get(room.id) ?? 0}
                </span>
              </button>
            );
          })}
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
