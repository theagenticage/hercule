/**
 * What the desktop app remembers about the model menu, in `localStorage`, one
 * value per controller URL because an id means nothing to another controller:
 *
 * - the Recent list: the entries (Provider Account, harness, model) the user
 *   picked lately, which the model menu shows per profile and a new thread in
 *   a project with a profile starts from. A thread adds its model to the list
 *   when a submission with a picked model is accepted;
 * - the Model Profile the user opened last in the menu.
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

/** Returns the `localStorage` key that holds the profile opened last for `controllerUrl`. */
const buildLastOpenProfileKey = (controllerUrl: string): string =>
  `last-open-model-profile:${controllerUrl}`;

/**
 * Returns the id of the Model Profile the user opened last in the model menu
 * for `controllerUrl`, or `null` when none is stored. The profile may have
 * been deleted since; the menu ignores such an id.
 */
export const readLastOpenProfileId = (controllerUrl: string): string | null =>
  localStorage.getItem(buildLastOpenProfileKey(controllerUrl));

/** Stores `profileId` as the Model Profile the user opened last for `controllerUrl`. */
export const rememberOpenProfile = (controllerUrl: string, profileId: string): void => {
  localStorage.setItem(buildLastOpenProfileKey(controllerUrl), profileId);
};
