/**
 * The room directory: a menu in the top bar listing every room of the
 * Office, so the user can fly the camera straight to one.
 *
 * The rooms come from the office as built now, so the list follows the
 * rooms as threads come and go. The project
 * rooms come first, each drawn as its project's tile, then the Office's
 * fixed rooms. Each room shows how many colleagues belong in it now, the
 * same count its label in the 3D view shows: see `countColleaguesByRoom`.
 */
import { useSyncExternalStore, type JSX } from "react";
import { ProjectTile } from "../../screens/project-tile";
import type { OfficeLayout, RoomInfo } from "../engine/contracts";
import { countColleaguesByRoom } from "../engine/room-counts";
import {
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
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
 * under "Projects", then every other room under "The Office", each in the
 * layout's order. Groups with no rooms are left out.
 */
export function groupRooms(rooms: ReadonlyArray<RoomInfo>): ReadonlyArray<RoomGroup> {
  const groups: ReadonlyArray<RoomGroup> = [
    { heading: "Projects", rooms: rooms.filter((room) => room.kind === "project") },
    { heading: "The Office", rooms: rooms.filter((room) => room.kind !== "project") },
  ];
  return groups.filter((group) => group.rooms.length > 0);
}

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
  const counts = countColleaguesByRoom(layout.rooms, layout.homes, states);
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
              <span
                className="count"
                aria-label={`${String(counts.get(room.id)?.colleagues ?? 0)} colleagues`}
              >
                {counts.get(room.id)?.colleagues ?? 0}
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
export function RoomDirectory({
  layout,
}: {
  /** The office as built now, or null before the scene mounts. */
  readonly layout: OfficeLayout | null;
}): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const room = layout?.rooms.find((each) => each.id === state.roomId);
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
        layout === null ? null : (
          <RoomList
            layout={layout}
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
