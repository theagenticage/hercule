/**
 * What the Work board remembers about how the user looks at it, in
 * `localStorage`: which lanes are folded, and the choices of the Display menu.
 * One entry per controller and user, because a lane's id means nothing to
 * another controller, and two people on one machine fold their own lanes.
 */
import type { WorkDisplay } from "./work-toolbar";

/** The choices of the Display menu before the user makes any. */
export const DEFAULT_WORK_DISPLAY: WorkDisplay = {
  laneLabels: "bands",
  isStill: false,
  hasSingleKeys: true,
};

/** What is kept: the ids of the folded lanes, and the Display choices. */
export interface SavedWorkView {
  readonly foldedLaneIds: readonly string[];
  readonly display: WorkDisplay;
}

/** The view of a user who has saved nothing: every lane open, the default Display. */
export const EMPTY_WORK_VIEW: SavedWorkView = { foldedLaneIds: [], display: DEFAULT_WORK_DISPLAY };

/** Returns the `localStorage` key that holds the view of `username` on the controller at `controllerUrl`. */
export const buildWorkViewKey = (controllerUrl: string, username: string): string =>
  `work-view:${controllerUrl}:${username}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Returns the view stored under `key`. A missing, unreadable or malformed
 * entry reads as the empty view, and so does each field that is not what it
 * should be, so one bad field never costs the user the rest.
 */
export const readSavedWorkView = (key: string): SavedWorkView => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return EMPTY_WORK_VIEW;
  }
  if (!isRecord(parsed)) return EMPTY_WORK_VIEW;
  const { foldedLaneIds, display } = parsed;
  const shown = isRecord(display) ? display : {};
  return {
    foldedLaneIds: Array.isArray(foldedLaneIds)
      ? foldedLaneIds.filter((id): id is string => typeof id === "string")
      : [],
    display: {
      laneLabels:
        shown["laneLabels"] === "bands" || shown["laneLabels"] === "side-labels"
          ? shown["laneLabels"]
          : DEFAULT_WORK_DISPLAY.laneLabels,
      isStill:
        typeof shown["isStill"] === "boolean" ? shown["isStill"] : DEFAULT_WORK_DISPLAY.isStill,
      hasSingleKeys:
        typeof shown["hasSingleKeys"] === "boolean"
          ? shown["hasSingleKeys"]
          : DEFAULT_WORK_DISPLAY.hasSingleKeys,
    },
  };
};

/** Stores `view` under `key`. A storage that refuses it loses nothing that matters, so the failure is ignored. */
export const writeSavedWorkView = (key: string, view: SavedWorkView): void => {
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {
    // The storage is full or denied: the board keeps the view for this window.
  }
};
