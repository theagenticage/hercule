/**
 * PROTOTYPE - the office's top bar: slim glass pills floating over the top of
 * the office, as the Bureau book's office header draws them.
 *
 * - The office's pill: its title, Overview, and the room directory.
 * - Event flow: a switch for the pneumatic tubes that carry events to Triage.
 * - The counts of who is doing what. A click on a count selects the next
 *   colleague in that state, so repeated clicks walk through all of them.
 * - Simulate: a menu that makes something happen in the office.
 * - The button that shows and hides the controls panel.
 *
 * While the thread drawer is open the bar has less room, so the counts drop
 * their words, Simulate drops its name, and Event flow hides; the controls
 * panel still has it.
 */
import { useSyncExternalStore, type JSX } from "react";
import { SlidersIcon } from "../../../icons";
import type { SimEvent } from "../engine/contracts";
import type { OfficeScene } from "../office-scene";
import {
  readColleagueStates,
  readOffice,
  sendOfficeCommand,
  setOffice,
  subscribeColleagueStates,
  subscribeOffice,
} from "../office-store";
import type { Pose, World } from "../world/types";
import { PoseMark } from "./dossier-card";
import { BoltIcon, ChevronDownIcon, OfficeIcon } from "./office-icons";
import { findNextColleagueId, listColleaguesInPose } from "./office-keys";
import { OfficeMenu } from "./office-menu";
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

/** The Simulate menu's items: one per kind of event the sim can play. */
const SIMULATIONS: ReadonlyArray<{
  readonly event: SimEvent;
  readonly name: string;
  readonly description: string;
}> = [
  { event: { kind: "ask" }, name: "Ask", description: "A working colleague asks you something" },
  { event: { kind: "visit" }, name: "Visit", description: "A colleague walks over to ask another" },
  { event: { kind: "arrive" }, name: "Arrive", description: "A new thread starts at a free desk" },
  { event: { kind: "fail" }, name: "Fail", description: "A colleague's turn fails" },
  { event: { kind: "finish" }, name: "Finish", description: "A colleague's turn finishes" },
  {
    event: { kind: "event" },
    name: "Event",
    description: "An event runs through the tubes to Triage",
  },
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

/** Renders the Simulate menu's trigger and its menu. */
function SimulateMenu(): JSX.Element {
  return (
    <OfficeMenu
      label="Simulate"
      align="end"
      triggerClassName="pill-btn"
      triggerLabel="Simulate"
      trigger={
        <>
          <BoltIcon size={14} />
          <span className="office-top-label">Simulate</span>
          <ChevronDownIcon size={12} />
        </>
      }
    >
      {() => (
        <>
          <div className="pop-h">
            <b>Simulate</b>
            <span>What happens next</span>
          </div>
          <div className="pop-sec">
            {SIMULATIONS.map(({ event, name, description }) => (
              <button
                key={event.kind}
                type="button"
                className="line"
                onClick={() => sendOfficeCommand({ kind: "simulate", event })}
              >
                <span className="grow">
                  <b>{name}</b>
                  <small>{description}</small>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </OfficeMenu>
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
      <span className="pill office-flow-pill">
        <button
          type="button"
          className="pill-btn flow-btn"
          role="switch"
          aria-checked={state.flow}
          onClick={() => setOffice({ flow: !state.flow })}
        >
          Event flow
          <span className="toggle" aria-hidden="true" />
        </button>
      </span>
      <span className="spacer" />
      <PoseCounts world={world} />
      <span className="pill">
        <SimulateMenu />
        <span className="pill-sep" />
        <button
          type="button"
          className="pill-btn pill-btn--icon"
          aria-label="Controls"
          aria-pressed={state.controls}
          aria-keyshortcuts="."
          title="Controls (.)"
          onClick={() => setOffice({ controls: !state.controls })}
        >
          <SlidersIcon size={16} />
        </button>
      </span>
    </header>
  );
}
