/**
 * What the web app remembers about the model menu on this device, in
 * `localStorage`: the entries the user picked lately, and the Model Profile
 * they had open last. The API stores neither. Storage can be unavailable or
 * hold something unreadable, and the menu works without both, so every
 * function here treats a failure as "nothing stored".
 */
import { parseRecentModels, type RecentModel } from "@hercule/client-core";

const RECENT_KEY = "hercule.recentModels";
const LAST_OPEN_PROFILE_KEY = "hercule.lastOpenModelProfile";

/** Returns the recently picked models, newest first, or an empty list when none can be read. */
export const readRecentModels = (): readonly RecentModel[] => {
  try {
    return parseRecentModels(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
};

/** Stores the recently picked models. A failed write is ignored: Recent is only a convenience. */
export const writeRecentModels = (recent: readonly RecentModel[]): void => {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // See above.
  }
};

/**
 * Returns the id of the Model Profile the user had open last in the model
 * menu, or `null` when none is stored. The id may name a profile that was
 * deleted since; the menu ignores such an id.
 */
export const readLastOpenProfileId = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_OPEN_PROFILE_KEY);
  } catch {
    return null;
  }
};

/** Stores the id of the Model Profile the user opened last. A failed write is ignored. */
export const rememberOpenProfile = (profileId: string): void => {
  try {
    window.localStorage.setItem(LAST_OPEN_PROFILE_KEY, profileId);
  } catch {
    // The menu then opens on the profile that holds the current entry.
  }
};
