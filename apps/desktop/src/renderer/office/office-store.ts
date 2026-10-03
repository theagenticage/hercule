/**
 * The Office's state that both the 3D scene and the React panels read: what
 * the user points at and has selected, whether the thread drawer is open,
 * and the room the camera last flew to.
 *
 * The Office has no settings of its own. Its theme and light follow the
 * app's theme, and the rest is fixed: see `OFFICE_SETTINGS`.
 *
 * The scene and the panels subscribe; anything can call `setOffice`. The
 * route keeps `selectedId` and `drawer` in step with its `session` search
 * param, see `office-screen.tsx`.
 */
import type { CharacterStyle, ColleagueState } from "./engine/contracts";
import type { Colleague } from "./world/types";

/** How many name tags the Office shows: all, the ones that matter now, or none. */
export type TagMode = "all" | "smart" | "none";

/**
 * The fixed values the Office runs with: how the colleagues look, which name
 * tags show, and how much the colleagues move about. The user cannot change
 * them; the scene passes each one to the part of the engine that uses it.
 */
export const OFFICE_SETTINGS: {
  readonly style: CharacterStyle;
  readonly tags: TagMode;
  /** How much the colleagues move about while nothing happens: 1 is calm. */
  readonly liveliness: 0 | 1 | 2;
} = { style: "bean", tags: "smart", liveliness: 1 };

export interface OfficeState {
  readonly hoveredId: string | null;
  readonly selectedId: string | null;
  /** The thread drawer is open on the selected colleague's thread. */
  readonly drawer: boolean;
  /** The room the camera last flew to, by the directory or a key. */
  readonly roomId: string | null;
}

let state: OfficeState = { hoveredId: null, selectedId: null, drawer: false, roomId: null };
const listeners = new Set<() => void>();

/** Returns the current state. The same object until something changes. */
export function readOffice(): OfficeState {
  return state;
}

/** Changes some fields and tells every subscriber, unless nothing changed. */
export function setOffice(change: Partial<OfficeState>): void {
  const next = { ...state, ...change };
  if ((Object.keys(change) as Array<keyof OfficeState>).every((key) => next[key] === state[key]))
    return;
  state = next;
  for (const listener of listeners) listener();
}

/** Calls `listener` after every change. Returns the function that unsubscribes. */
export function subscribeOffice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Commands: what the panels ask the scene to do, beyond changing state.

/** A command from the panels and the keys to the scene. */
export type OfficeCommand =
  | { readonly kind: "overview" }
  | { readonly kind: "focus-room"; readonly roomId: string }
  | { readonly kind: "focus-colleague"; readonly colleagueId: string }
  /** Turns the camera around the point it looks at: a positive turn is clockwise from above. */
  | { readonly kind: "turn-camera"; readonly degrees: number }
  | { readonly kind: "zoom-camera"; readonly direction: "in" | "out" }
  /** Follows the selected colleague again after the user moved the camera away. */
  | { readonly kind: "resume-follow" };

const commandListeners = new Set<(command: OfficeCommand) => void>();

/** Sends a command to the scene. */
export function sendOfficeCommand(command: OfficeCommand): void {
  for (const listener of commandListeners) listener(command);
}

/** Calls `listener` with every command. Returns the function that unsubscribes. */
export function onOfficeCommand(listener: (command: OfficeCommand) => void): () => void {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// The colleagues' live states, as the scene's sim holds them, for the panels.

let colleagueStates: ReadonlyMap<string, ColleagueState> = new Map();
const stateListeners = new Set<() => void>();

/**
 * Returns every colleague's state now, by id. A colleague missing from the
 * map has the state the world gives it. The same map until a state changes.
 */
export function readColleagueStates(): ReadonlyMap<string, ColleagueState> {
  return colleagueStates;
}

/** Replaces the colleagues' states and tells every subscriber. Only the scene calls it. */
export function publishColleagueStates(states: ReadonlyMap<string, ColleagueState>): void {
  if (states === colleagueStates) return;
  colleagueStates = states;
  for (const listener of stateListeners) listener();
}

/** Calls `listener` after the colleagues' states change. Returns the function that unsubscribes. */
export function subscribeColleagueStates(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Returns `colleague` with the pose, request and state label the sim holds for it now, in `states`. */
export function applyColleagueState(
  colleague: Colleague,
  states: ReadonlyMap<string, ColleagueState>,
): Colleague {
  const live = states.get(colleague.id);
  return live === undefined ? colleague : { ...colleague, ...live };
}
