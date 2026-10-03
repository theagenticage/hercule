/**
 * PROTOTYPE - the Tower's floor plan, before anything is built: which
 * storeys the tower has, and which rooms and colleagues each storey holds.
 *
 * The ground floor is the lobby. Above it is one storey per runner, in the
 * order of the fleet, and the penthouse sits on top. A runner's sessions sit
 * on its storey, in one room per project (and one reading room for the work
 * that belongs to no project), sorted by code area so an area's desks stand
 * together. Triage works in the lobby; the assistants live in the penthouse,
 * whatever runner their heartbeat runs on.
 */
import type { Area, Colleague, ProjectKey, RunnerInfo, World } from "../world/types";
import { AREA_PROJECT } from "../world/types";

/** What a room on a runner's storey holds: one project's work, or the work of no project. */
export type RoomGroup = ProjectKey | "reading";

/** One room on a runner's storey. */
export interface PlannedRoom {
  /** Unique in the whole tower: the runner's id and the group. */
  readonly id: string;
  readonly label: string;
  readonly group: RoomGroup;
  /** The room's colleagues, sorted by code area. */
  readonly colleagues: ReadonlyArray<Colleague>;
}

/** One runner's storey. */
export interface PlannedStorey {
  readonly runner: RunnerInfo;
  /** The storey's index: 1 for the first runner, as the lobby is 0. */
  readonly floor: number;
  readonly rooms: ReadonlyArray<PlannedRoom>;
  /** The number of sessions on the runner. */
  readonly sessions: number;
}

/** The whole tower's plan. */
export interface TowerPlan {
  readonly storeys: ReadonlyArray<PlannedStorey>;
  /** The penthouse's storey index: one above the last runner. */
  readonly penthouseFloor: number;
  /** Triage, who works in the lobby's case room. */
  readonly triage: ReadonlyArray<Colleague>;
  /** The assistants, who live in the penthouse. */
  readonly assistants: ReadonlyArray<Colleague>;
}

/** The order rooms stand in on a storey, west to east. */
const GROUP_ORDER: ReadonlyArray<RoomGroup> = ["webshop", "payments-api", "ops", "reading"];

/** The order areas sit in within a room, as `AREA_PROJECT` lists them. */
const AREA_ORDER = Object.keys(AREA_PROJECT) as ReadonlyArray<Area>;

/** Returns the room group a colleague's area belongs to. */
function decideRoomGroup(area: Area): RoomGroup {
  return AREA_PROJECT[area] ?? "reading";
}

/**
 * Returns a room's label, such as "Webshop". A project has a room on many
 * storeys, but the overlay shows room labels only for the storey in view, and
 * the directory names each room's storey after it.
 */
function buildRoomLabel(group: RoomGroup): string {
  const name = group === "reading" ? "reading room" : group;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * Plans the tower for a world. A session whose runner is missing from the
 * world's fleet sits on the first runner's storey, so every colleague has a
 * home.
 */
export function planTower(world: World): TowerPlan {
  const sessionsByRunner = new Map<string, Colleague[]>();
  const triage: Colleague[] = [];
  const assistants: Colleague[] = [];
  const firstRunnerId = world.runners[0]?.id ?? "";
  for (const colleague of world.colleagues) {
    if (colleague.role === "triage") {
      triage.push(colleague);
    } else if (colleague.role === "assistant") {
      assistants.push(colleague);
    } else {
      const known = world.runners.some((runner) => runner.id === colleague.runnerId);
      const runnerId = known && colleague.runnerId !== null ? colleague.runnerId : firstRunnerId;
      sessionsByRunner.set(runnerId, [...(sessionsByRunner.get(runnerId) ?? []), colleague]);
    }
  }
  const storeys = world.runners.map((runner, index): PlannedStorey => {
    const sessions = sessionsByRunner.get(runner.id) ?? [];
    const rooms = GROUP_ORDER.flatMap((group): PlannedRoom[] => {
      const colleagues = sessions
        .filter((colleague) => decideRoomGroup(colleague.area) === group)
        .sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
      if (colleagues.length === 0) return [];
      return [{ id: `${runner.id}/${group}`, label: buildRoomLabel(group), group, colleagues }];
    });
    return { runner, floor: index + 1, rooms, sessions: sessions.length };
  });
  return { storeys, penthouseFloor: storeys.length + 1, triage, assistants };
}
