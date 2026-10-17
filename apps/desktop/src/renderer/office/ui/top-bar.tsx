/**
 * The Office's top bar: slim glass pills floating over the top of the
 * Office, as the Bureau book's office header draws them.
 *
 * - The Office's pill: its title, Overview, and the room directory.
 * - The counts of who is doing what. A click on a count selects the next
 *   colleague in that state, so repeated clicks walk through all of them.
 *
 * While the drawer is open the bar has less room, so the counts drop
 * their words.
 */
import { useSyncExternalStore, type JSX } from "react";
import type { BuiltOffice } from "../engine/contracts";
import {
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  setOffice,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import { describePose, type OfficePose } from "@hercule/client-core";
import type { World } from "../world/types";
import { Mark } from "../../marks";
import { OfficeIcon } from "../../icons/office";
import { findNextColleagueId, listColleaguesInPose } from "./office-keys";
import { RoomDirectory } from "./room-directory";

/**
 * The poses the bar counts, in its order: working, waiting and idle, and
 * done, the pose of an agent step's session that has finished while its run
 * goes on. The counts take assistants in those poses too. An asleep or away
 * colleague, thread or assistant, is not counted: those poses have no mark,
 * and the sidebar's foot counts only the first three poses.
 */
const COUNTED_POSES = [
  "working",
  "waiting",
  "idle",
  "done",
] as const satisfies ReadonlyArray<OfficePose>;

/** Renders the counts of who is doing what. Poses nobody is in are left out. */
function PoseCounts({ world }: { readonly world: World }): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const states = useSyncExternalStore(subscribeColleagueStates, readColleagueStates);
  return (
    <span className="pill sum" role="group" aria-label="Who is doing what">
      {COUNTED_POSES.map((pose) => {
        const colleagues = listColleaguesInPose(world, states, pose);
        if (colleagues.length === 0) return null;
        const words = describePose(pose);
        return (
          <button
            key={pose}
            type="button"
            className={pose === "waiting" ? "sum-btn sum-you" : "sum-btn"}
            aria-label={`${String(colleagues.length)} ${words}`}
            title={`Select the next colleague ${words}`}
            onClick={() => {
              const colleagueId = findNextColleagueId(colleagues, state.selectedId, 1);
              if (colleagueId !== null) setOffice({ selectedId: colleagueId });
            }}
          >
            <Mark state={pose} />
            <b>{colleagues.length}</b>
            <span className="sum-words">{words}</span>
          </button>
        );
      })}
    </span>
  );
}

/** Renders the top bar over the office of `world`. */
export function TopBar({
  world,
  office,
}: {
  readonly world: World;
  /** The office as built now, or null before the scene mounts. */
  readonly office: BuiltOffice | null;
}): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const inOverview = state.selectedId === null && state.roomId === null;
  return (
    <header className="office-top">
      <nav className="pill" aria-label="Office">
        <span className="pill-title">Office</span>
        <button
          type="button"
          className={inOverview ? "ptab is-on" : "ptab"}
          aria-pressed={inOverview}
          onClick={() => sendOfficeCommand({ kind: "overview" })}
        >
          <OfficeIcon size={14} />
          Overview
        </button>
        <RoomDirectory office={office} />
      </nav>
      <span className="spacer" />
      <PoseCounts world={world} />
    </header>
  );
}
