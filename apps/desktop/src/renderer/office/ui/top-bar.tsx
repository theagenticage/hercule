/**
 * The Office's top bar: slim glass pills floating over the top of the
 * Office, as the Bureau book's office header draws them.
 *
 * - The Office's pill: its title, Overview, and the room directory.
 * - The counts of who is doing what. A click on a count selects the next
 *   colleague in that state, so repeated clicks walk through all of them.
 *
 * While the thread drawer is open the bar has less room, so the counts drop
 * their words.
 */
import { useSyncExternalStore, type JSX } from "react";
import type { OfficeScene } from "../office-scene";
import {
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import type { Pose, World } from "../world/types";
import { PoseMark } from "./dossier-card";
import { OfficeIcon } from "../../icons/office";
import { findNextColleagueId, listColleaguesInPose } from "./office-keys";
import { RoomDirectory } from "./room-directory";

/**
 * The counts of the bar, in its order: the poses each one counts, and the
 * words after its number. Its mark is its first pose's. A colleague that is
 * done counts as idle, which it becomes a moment later, and one that is away
 * counts as asleep, so the bar holds six counts at most and fits beside the
 * other pills.
 */
const COUNTS: ReadonlyArray<{ readonly poses: ReadonlyArray<Pose>; readonly words: string }> = [
  { poses: ["working"], words: "working" },
  { poses: ["waiting"], words: "waiting on you" },
  { poses: ["paused"], words: "paused" },
  { poses: ["failed"], words: "failed" },
  { poses: ["idle", "done"], words: "idle" },
  { poses: ["asleep", "away"], words: "asleep" },
];

/** Renders the counts of who is doing what. Poses nobody is in are left out. */
function PoseCounts({ world }: { readonly world: World }): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  const states = useSyncExternalStore(subscribeColleagueStates, readColleagueStates);
  return (
    <span className="pill sum" role="group" aria-label="Who is doing what">
      {COUNTS.map(({ poses, words }) => {
        const colleagues = poses.flatMap((pose) => listColleaguesInPose(world, states, pose));
        if (colleagues.length === 0) return null;
        const pose = poses[0]!;
        return (
          <button
            key={pose}
            type="button"
            className={pose === "waiting" ? "sum-btn sum-you" : "sum-btn"}
            aria-label={`${String(colleagues.length)} ${words}`}
            title={`Select the next colleague ${words}`}
            onClick={() => {
              const colleagueId = findNextColleagueId(colleagues, state.selectedId, 1);
              if (colleagueId !== null) sendOfficeCommand({ kind: "focus-colleague", colleagueId });
            }}
          >
            <PoseMark pose={pose} />
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
  scene,
}: {
  readonly world: World;
  readonly scene: OfficeScene | null;
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
        <RoomDirectory scene={scene} />
      </nav>
      <span className="spacer" />
      <PoseCounts world={world} />
    </header>
  );
}
