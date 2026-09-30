/**
 * The Recent list: the last three (instance, model) pairs the user picked,
 * which the model menu shows first.
 *
 * The list is kept in `localStorage`, one entry per controller URL, because
 * an instance id means nothing to another controller. A thread adds its
 * model to the list when a submission with a picked model is accepted.
 */
import { parseRecentModels, pushRecent, type RecentModel } from "@hercule/client-core";

/** Returns the `localStorage` key that holds the Recent list for `controllerUrl`. */
const buildStorageKey = (controllerUrl: string): string => `recent-models:${controllerUrl}`;

/**
 * Returns the Recent list for `controllerUrl`, newest first. Returns an empty
 * list when none is stored or the stored text cannot be read.
 */
export const readRecentModels = (controllerUrl: string): readonly RecentModel[] =>
  parseRecentModels(localStorage.getItem(buildStorageKey(controllerUrl)));

/** Moves or adds `pair` to the front of the Recent list for `controllerUrl`. */
export const rememberRecentModel = (controllerUrl: string, pair: RecentModel): void => {
  const recent = pushRecent(readRecentModels(controllerUrl), pair);
  localStorage.setItem(buildStorageKey(controllerUrl), JSON.stringify(recent));
};
