/**
 * The view of the Overview the user used last, which the sidebar's Overview
 * row opens again. The Overview is one place drawn on two routes: the Office
 * at `/office` and Work at `/work`.
 *
 * The view is kept in `localStorage`, one entry per controller URL, as the
 * last screen is: this desktop app signs in one user per controller. The
 * sidebar reads it while it draws, so a change is announced to subscribers.
 */

/** A view of the Overview: the Office, or Work. */
export type OverviewView = "office" | "work";

/** The view the Overview row opens before the user has used either. */
const FIRST_VIEW: OverviewView = "work";

/** Returns the `localStorage` key that holds the last Overview view for `controllerUrl`. */
const buildStorageKey = (controllerUrl: string): string => `overview-view:${controllerUrl}`;

const listeners = new Set<() => void>();

/**
 * Returns the view used last for `controllerUrl`, or Work when none is
 * stored or the stored text is not a view.
 */
export const readOverviewView = (controllerUrl: string): OverviewView =>
  localStorage.getItem(buildStorageKey(controllerUrl)) === "office" ? "office" : FIRST_VIEW;

/** Stores `view` as the view used last for `controllerUrl`, and tells the subscribers when it changed. */
export const rememberOverviewView = (controllerUrl: string, view: OverviewView): void => {
  const changed = readOverviewView(controllerUrl) !== view;
  localStorage.setItem(buildStorageKey(controllerUrl), view);
  if (changed) for (const listener of listeners) listener();
};

/** Calls `listener` after every change. Returns the function that unsubscribes. */
export const subscribeOverviewView = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
