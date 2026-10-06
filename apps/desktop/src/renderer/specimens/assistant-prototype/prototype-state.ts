/**
 * PROTOTYPE (#448). What the switcher picks, kept in the page's URL so a
 * view can be shared and survives a reload: `?variant=`, `?state=` and
 * `?theme=`. The router runs on a memory history, so the URL is written here
 * with `history.replaceState`, outside the router.
 *
 * It also holds what the screen reports to the sidebar (Ada's pose) and the
 * switcher's "heartbeat now" signal.
 */
import { useSyncExternalStore } from "react";
import type { Pose } from "@hercule/client-core";

export const VARIANTS = [
  { key: "A", name: "Book: rail beside the conversation" },
  { key: "B", name: "Floating header, rail in a drawer" },
  { key: "C", name: "Today's contract: no rail" },
] as const;
export type Variant = (typeof VARIANTS)[number]["key"];

export const STATES = [
  { key: "streaming", name: "Answering" },
  { key: "idle", name: "Idle" },
  { key: "approval", name: "Waiting on approval" },
  { key: "asleep", name: "Asleep" },
  { key: "unreachable", name: "Can't be reached" },
] as const;
export type ScreenState = (typeof STATES)[number]["key"];

export const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"] as const;
export type Theme = (typeof THEMES)[number];

interface PrototypeState {
  readonly variant: Variant;
  readonly state: ScreenState;
  readonly theme: Theme;
  /** Ada's pose as her screen last drew it, or `null` before it opens. */
  readonly adaPose: Pose | null;
  /** Counts the switcher's "heartbeat now" presses. */
  readonly heartbeats: number;
}

const readParam = <T extends string>(name: string, allowed: ReadonlyArray<T>, fallback: T): T => {
  const value = new URLSearchParams(location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
};

let current: PrototypeState = {
  variant: readParam(
    "variant",
    VARIANTS.map((each) => each.key),
    "A",
  ),
  state: readParam(
    "state",
    STATES.map((each) => each.key),
    "streaming",
  ),
  theme: readParam("theme", THEMES, "whitehaven"),
  adaPose: null,
  heartbeats: 0,
};
document.documentElement.dataset.theme = current.theme;

const listeners = new Set<() => void>();

/** Merges `change` into the state, writes the URL and the theme, and tells every reader. */
export const updatePrototype = (change: Partial<PrototypeState>): void => {
  current = { ...current, ...change };
  const params = new URLSearchParams(location.search);
  params.set("variant", current.variant);
  params.set("state", current.state);
  params.set("theme", current.theme);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  document.documentElement.dataset.theme = current.theme;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns the prototype's state, and draws again when it changes. */
export const usePrototype = (): PrototypeState => useSyncExternalStore(subscribe, () => current);
