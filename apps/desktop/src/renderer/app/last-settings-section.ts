/**
 * The Settings section opened last, which Settings opens again (spec 17
 * §Settings, The frame).
 *
 * It is kept in memory only, so it lasts while the app runs: the section is
 * not kept across launches. The first time, Settings opens Appearance, as
 * the book's button at the foot of the sidebar links to it.
 *
 * Each section's route records itself when it opens. `/settings` reads it to
 * decide where to go.
 */
import type { FileRouteTypes } from "../routeTree.gen";

/** The path of one Settings section, such as `/settings/profile`. */
export type SettingsSectionPath = Extract<FileRouteTypes["to"], `/settings/${string}`>;

/** The section Settings opens before the user has opened one in this run. */
const FIRST_SECTION: SettingsSectionPath = "/settings/appearance";

let lastSection: SettingsSectionPath = FIRST_SECTION;

/** Records `path` as the Settings section opened last. */
export const rememberSettingsSection = (path: SettingsSectionPath): void => {
  lastSection = path;
};

/** Returns the Settings section opened last in this run, or the first section when none was. */
export const readLastSettingsSection = (): SettingsSectionPath => lastSection;

/**
 * Forgets the section opened last, as a new launch does. For tests, which
 * share this module across the tests of one file.
 */
export const forgetLastSettingsSection = (): void => {
  lastSection = FIRST_SECTION;
};
