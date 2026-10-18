/**
 * PROTOTYPE (#731). What the switcher picks, kept in the page's URL so a
 * view can be shared and survives a reload: `?scene=` and `?theme=`. The
 * router runs on a memory history, so the URL is written here with
 * `history.replaceState`, outside the router.
 */
import { useSyncExternalStore } from "react";

/**
 * The scenes the switcher offers. Each opens one address: the list, or the
 * page of the skill it names. The scenes marked `later` show what slices 4
 * and 5 (#735, #736) add.
 */
export const SCENES = [
  { key: "list", name: "List", skill: null, later: false },
  { key: "detail", name: "Detail: grilling", skill: "grilling", later: false },
  { key: "warning", name: "Detail: allowed-tools warning", skill: "playwright-cli", later: false },
  { key: "delete", name: "Delete: confirm", skill: "teach", later: false },
  { key: "import", name: "Import: the picked folder", skill: null, later: false },
  { key: "import-running", name: "Import: running, with refusals", skill: null, later: false },
  {
    key: "import-conflict",
    name: "Import: exists with different content",
    skill: null,
    later: false,
  },
  { key: "import-done", name: "Import: done", skill: null, later: false },
  { key: "empty", name: "Empty library", skill: null, later: false },
  { key: "updates", name: "Later: badges, Check now, Update all", skill: null, later: true },
  { key: "update-all", name: "Later: Update all confirm", skill: null, later: true },
  { key: "update", name: "Later: an update's diff", skill: "code-review", later: true },
  {
    key: "approvals",
    name: "Later: an update that may change approvals",
    skill: "triage",
    later: true,
  },
  { key: "proposed", name: "Later: Ada's proposed skill", skill: "release-checklist", later: true },
  {
    key: "tainted",
    name: "Later: a proposal with third-party content",
    skill: "ship",
    later: true,
  },
  { key: "applied", name: "Later: applied by Ada", skill: "release-checklist", later: true },
] as const;
export type Scene = (typeof SCENES)[number]["key"];

export const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"] as const;
export type Theme = (typeof THEMES)[number];

interface PrototypeState {
  readonly scene: Scene;
  readonly theme: Theme;
}

const readParam = <T extends string>(name: string, allowed: ReadonlyArray<T>, fallback: T): T => {
  const value = new URLSearchParams(location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
};

let current: PrototypeState = {
  scene: readParam(
    "scene",
    SCENES.map((each) => each.key),
    "list",
  ),
  theme: readParam("theme", THEMES, "whitehaven"),
};

/** Writes the state to the URL and the theme to the page. */
const writeState = (): void => {
  const params = new URLSearchParams(location.search);
  params.set("scene", current.scene);
  params.set("theme", current.theme);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  document.documentElement.dataset.theme = current.theme;
};
writeState();

const listeners = new Set<() => void>();

/** Merges `change` into the state, writes the URL and the theme, and tells every reader. */
export const updatePrototype = (change: Partial<PrototypeState>): void => {
  current = { ...current, ...change };
  writeState();
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns the prototype's state as it is now, for code outside React. */
export const readPrototype = (): PrototypeState => current;

/** Returns the prototype's state, and draws again when it changes. */
export const usePrototype = (): PrototypeState => useSyncExternalStore(subscribe, () => current);

/** Returns the scene `key` names. */
export const findScene = (key: Scene): (typeof SCENES)[number] =>
  SCENES.find((each) => each.key === key)!;

/** Returns the app's address that scene `key` opens. */
export const buildScenePath = (key: Scene): string => {
  const { skill } = findScene(key);
  return skill === null ? "/settings/skills" : `/settings/skills/${skill}`;
};
