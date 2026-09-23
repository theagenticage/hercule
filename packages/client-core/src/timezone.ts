/**
 * The IANA zones this runtime knows, and which one the browser is in.
 *
 * A zone is supported when this runtime's `Intl.DateTimeFormat` accepts it.
 * That is the constraint that matters, because formatting a time in an unknown
 * zone throws. The supported set is wider than the canonical list: link names
 * like `US/Pacific` and `Asia/Kolkata` format fine but are not in the list. So
 * a zone set from the CLI or another client is used as it is, not replaced.
 *
 * Every screen's picker uses the canonical list, because a picker should show
 * one entry per zone rather than every name for it.
 *
 * The browser's own zone is checked before it is offered. If the runtime
 * reports a zone it cannot format, UTC is used instead. The onboarding step
 * shows it for the user to confirm or change; it is never saved silently.
 *
 * The resolver is a parameter so a test can choose the zone.
 */

/** Returns the current zone: the browser's, or one a test chooses. */
export type TimezoneResolver = () => string;

const resolveFromIntl: TimezoneResolver = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The zone offered when the runtime reports a zone it cannot format. */
export const FALLBACK_TIMEZONE = "UTC";

/**
 * Some runtimes leave UTC out of the canonical list. UTC can always be
 * formatted and is the fallback for the browser's zone, so it is always in the
 * list.
 *
 * The list never changes within a page load and the picker rebuilds it on
 * every render, so it is built once.
 */
const CANONICAL_ZONES: readonly string[] = (() => {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(FALLBACK_TIMEZONE) ? zones : [FALLBACK_TIMEZONE, ...zones];
})();

/** Returns the zones a screen offers, in the order the runtime lists them. */
export const listSupportedTimezones = (): readonly string[] => CANONICAL_ZONES;

/** Checks whether this runtime can format times in `timezone`. */
export const isSupportedTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

/** Returns the browser's zone when this runtime supports it, and UTC otherwise. */
export const resolveBrowserTimezone = (resolve: TimezoneResolver = resolveFromIntl): string => {
  const zone = resolve();
  return isSupportedTimezone(zone) ? zone : FALLBACK_TIMEZONE;
};
