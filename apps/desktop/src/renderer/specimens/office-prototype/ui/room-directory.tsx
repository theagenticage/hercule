/**
 * PROTOTYPE - the room directory: a menu in the top bar listing every room
 * of the office, so the user can fly the camera straight to one.
 *
 * The rooms come from the scene's current layout, read each time the menu
 * opens, so a change of variant shows that variant's rooms. Code rooms come
 * first, grouped by project; the office's other rooms follow. Each room
 * shows how many colleagues have their desk in it.
 */
import { useSyncExternalStore, type JSX } from "react";
import { ProjectTile } from "../../../screens/project-tile";
import type { OfficeLayout, RoomInfo } from "../engine/contracts";
import type { OfficeScene } from "../office-scene";
import { readOffice, sendOfficeCommand, subscribeOffice } from "../office-store";
import { findProjectTint } from "./dossier-card";
import { ChevronDownIcon, ListIcon } from "./office-icons";
import { OfficeMenu } from "./office-menu";

/** One heading of the directory and its rooms. A null project heads the office's other rooms. */
interface RoomGroup {
  readonly project: string | null;
  readonly rooms: ReadonlyArray<RoomInfo>;
}

/**
 * Returns the rooms of `rooms` in the directory's groups: one group per
 * project, holding that project's code rooms, in the order the projects first
 * appear, then one group of every other room. A code room of no project goes
 * with the other rooms.
 */
export function groupRooms(rooms: ReadonlyArray<RoomInfo>): ReadonlyArray<RoomGroup> {
  const byProject = new Map<string, Array<RoomInfo>>();
  const others: Array<RoomInfo> = [];
  for (const room of rooms) {
    if (room.kind !== "code" || room.project === null) others.push(room);
    else byProject.set(room.project, [...(byProject.get(room.project) ?? []), room]);
  }
  return [
    ...[...byProject].map(([project, projectRooms]) => ({ project, rooms: projectRooms })),
    ...(others.length === 0 ? [] : [{ project: null, rooms: others }]),
  ];
}

/** Returns how many colleagues of `layout` have their desk in each room, by room id. */
const countColleaguesByRoom = (layout: OfficeLayout): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const seat of layout.homes.values())
    counts.set(seat.roomId, (counts.get(seat.roomId) ?? 0) + 1);
  return counts;
};

/**
 * Returns the name of storey `floor` as the directory writes it after a room:
 * the label of the storey's own "floor" room when it has one, such as
 * "build-box-1", else "ground floor" or "floor 2".
 */
const nameFloor = (layout: OfficeLayout, floor: number): string =>
  layout.rooms.find((room) => room.kind === "floor" && room.floor === floor)?.label ??
  (floor === 0 ? "ground floor" : `floor ${String(floor)}`);

/**
 * Renders the directory's list of rooms, the room the camera is in marked.
 * In an office of several storeys each room also names its storey, because
 * rooms on different storeys share labels, such as each storey's Webshop.
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
  const storeyed = new Set(layout.rooms.map((room) => room.floor)).size > 1;
  return (
    <>
      <div className="pop-h">
        <b>Rooms</b>
        <span>{layout.rooms.length} rooms</span>
      </div>
      {groupRooms(layout.rooms).map((group) => (
        <div className="pop-sec" key={group.project ?? ""}>
          <div className="q-h">
            {group.project === null ? (
              "The office"
            ) : (
              <ProjectTile tint={findProjectTint(group.project)} name={group.project} />
            )}
          </div>
          {group.rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={room.id === roomId ? "line is-on" : "line"}
              aria-current={room.id === roomId || undefined}
              onClick={() => onPick(room.id)}
            >
              <span className="grow">
                <b>{room.label}</b>
                {storeyed && room.kind !== "floor" ? (
                  <span className="faint"> · {nameFloor(layout, room.floor)}</span>
                ) : null}
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
