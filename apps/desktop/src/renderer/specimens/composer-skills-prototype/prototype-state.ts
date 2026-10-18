/**
 * PROTOTYPE (#766). What the switcher picks, kept in the page's URL so a
 * view can be shared and survives a reload: `?scene=` and `?theme=`.
 *
 * A scene decides which records the thread is mounted with and whether its
 * transcript starts scrolled away, and both happen once, when the page
 * loads. So opening another scene loads the page again at its address. The
 * theme only sets `data-theme`, so it changes in place.
 */
import { useSyncExternalStore } from "react";
import { SCENES, type Scene } from "./scenes";

/** The two themes the prototype is drawn in. */
export const THEMES = ["whitehaven", "orient-express"] as const;
export type Theme = (typeof THEMES)[number];

const readParam = <T extends string>(name: string, allowed: ReadonlyArray<T>, fallback: T): T => {
  const value = new URLSearchParams(location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
};

const sceneKey = readParam(
  "scene",
  SCENES.map((each) => each.key),
  SCENES[0]!.key,
);

let theme: Theme = readParam("theme", THEMES, "whitehaven");

/** Writes the scene and the theme to the URL, and the theme to the page. */
const writeState = (): void => {
  const params = new URLSearchParams(location.search);
  params.set("scene", sceneKey);
  params.set("theme", theme);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  document.documentElement.dataset.theme = theme;
};
writeState();

const listeners = new Set<() => void>();

/** Sets the theme, writes it to the URL and the page, and tells every reader. */
export const updateTheme = (next: Theme): void => {
  theme = next;
  writeState();
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns the key of the scene this page was loaded with. */
export const readSceneKey = (): string => sceneKey;

/** Returns the theme, and draws again when it changes. */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, () => theme);

/** Loads the page again with scene `key` and the current theme. */
export const openScene = (key: Scene["key"]): void => {
  const params = new URLSearchParams(location.search);
  params.set("scene", key);
  params.set("theme", theme);
  location.assign(`${location.pathname}?${params.toString()}`);
};
