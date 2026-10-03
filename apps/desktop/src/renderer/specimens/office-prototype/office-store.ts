/**
 * PROTOTYPE - the office's state that both the 3D scene and the React panels
 * read: the controls, and what the user has selected. Every field is kept in
 * the page's URL, so any view of the office can be shared, reloaded and
 * captured exactly.
 *
 * The scene and the panels subscribe; anything can call `setOffice`.
 */
import type { CharacterStyle, ColleagueState, SimEvent } from "./engine/contracts";
import type { Quality, TimeOfDay } from "./engine/stage";
import type { FleetSize } from "./world/types";

/** The variants: three ways to organise the office and the fleet. */
export const VARIANTS = [
  { key: "A", id: "bureau", name: "Bureau floor" },
  { key: "B", id: "tower", name: "Tower" },
  { key: "C", id: "campus", name: "Campus" },
] as const;
export type VariantKey = (typeof VARIANTS)[number]["key"];

/** The five Bureau themes. */
export const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"] as const;
export type ThemeName = (typeof THEMES)[number];

/** How many name tags the office shows. */
export type TagMode = "all" | "smart" | "none";

export interface OfficeState {
  readonly variant: VariantKey;
  readonly theme: ThemeName;
  readonly timeOfDay: TimeOfDay;
  readonly fleet: FleetSize;
  readonly style: CharacterStyle;
  readonly quality: Quality;
  readonly liveliness: 0 | 1 | 2;
  /** Draws the pneumatic tubes that carry events to Triage. */
  readonly flow: boolean;
  readonly tags: TagMode;
  /** Draws the app's sidebar beside the office. */
  readonly sidebar: boolean;
  /** Draws the performance overlay. */
  readonly perf: boolean;
  /** Draws the controls panel. */
  readonly controls: boolean;
  readonly hoveredId: string | null;
  readonly selectedId: string | null;
  /** The thread drawer is open on the selected colleague's thread. */
  readonly drawer: boolean;
  /** The room the camera last flew to, by the directory or a key. */
  readonly roomId: string | null;
}

const DEFAULTS: OfficeState = {
  variant: "A",
  theme: "whitehaven",
  timeOfDay: "auto",
  fleet: "today",
  style: "bean",
  quality: "high",
  liveliness: 1,
  // The design opens with the tubes hidden. The prototype shows them, so the
  // capsules that carry events to Triage are seen without looking for a switch.
  flow: true,
  tags: "smart",
  sidebar: true,
  perf: false,
  controls: false,
  hoveredId: null,
  selectedId: null,
  drawer: false,
  roomId: null,
};

/** The fields kept out of the URL: they change on every mouse move. */
const TRANSIENT: ReadonlySet<keyof OfficeState> = new Set(["hoveredId"]);

/** Reads the state from the URL, falling back to the defaults field by field. */
function readUrl(): OfficeState {
  const params = new URLSearchParams(location.search);
  const state: Record<string, unknown> = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Array<keyof OfficeState>) {
    const raw = params.get(key === "selectedId" ? "select" : key === "roomId" ? "room" : key);
    if (raw === null) continue;
    const fallback = DEFAULTS[key];
    state[key] =
      typeof fallback === "boolean"
        ? raw === "1" || raw === "true"
        : typeof fallback === "number"
          ? Number(raw)
          : raw;
  }
  return state as unknown as OfficeState;
}

/** Writes every field that differs from its default into the URL, without a new history entry. */
function writeUrl(state: OfficeState): void {
  const params = new URLSearchParams();
  for (const key of Object.keys(DEFAULTS) as Array<keyof OfficeState>) {
    if (TRANSIENT.has(key) || state[key] === DEFAULTS[key] || state[key] === null) continue;
    const name = key === "selectedId" ? "select" : key === "roomId" ? "room" : key;
    const value = state[key];
    params.set(name, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const query = params.toString();
  history.replaceState(null, "", query.length > 0 ? `?${query}` : location.pathname);
}

let state = readUrl();
const listeners = new Set<() => void>();

/** Returns the current state. The same object until something changes. */
export function readOffice(): OfficeState {
  return state;
}

/** Changes some fields, writes the URL, and tells every subscriber. */
export function setOffice(change: Partial<OfficeState>): void {
  const next = { ...state, ...change };
  if ((Object.keys(change) as Array<keyof OfficeState>).every((key) => next[key] === state[key]))
    return;
  state = next;
  writeUrl(state);
  document.documentElement.dataset.theme = state.theme;
  for (const listener of listeners) listener();
}

/** Calls `listener` after every change. Returns the function that unsubscribes. */
export function subscribeOffice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Commands: what the panels ask the scene to do, beyond changing state.

/** A command from the panels to the scene. */
export type OfficeCommand =
  | { readonly kind: "answer"; readonly colleagueId: string; readonly answer: string }
  | { readonly kind: "simulate"; readonly event: SimEvent }
  | { readonly kind: "overview" }
  | { readonly kind: "focus-room"; readonly roomId: string }
  | { readonly kind: "focus-colleague"; readonly colleagueId: string };

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

document.documentElement.dataset.theme = state.theme;
