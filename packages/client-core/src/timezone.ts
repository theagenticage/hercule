/**
 * The IANA zones this runtime knows, and which one the browser is in.
 *
 * A zone is supported when this runtime's own `Intl.DateTimeFormat` accepts
 * it, which is the constraint that matters: an unknown zone throws wherever a
 * time is read. That set is wider than the canonical list - link names like
 * `US/Pacific` and `Asia/Kolkata` format perfectly well without appearing in
 * it - so a zone written from the CLI or from another client is read as it was
 * meant rather than downgraded.
 *
 * The list every screen picks from is the canonical one, because a picker
 * wants one entry per zone rather than every spelling of it.
 *
 * The browser's own zone is checked before it is offered. A runtime that
 * reports a zone it cannot format is answering with something unusable, so the
 * answer becomes UTC - shown on the onboarding step for the user to confirm or
 * change, never sent silently.
 *
 * The resolver is a parameter so a test can name a zone.
 */

/** Where the zone comes from: the browser, or whatever a test hands in. */
export type TimezoneResolver = () => string;

const resolveFromIntl: TimezoneResolver = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The zone offered when the runtime's own answer is not one it knows. */
export const FALLBACK_TIMEZONE = "UTC";

/**
 * Some runtimes leave UTC out of the canonical list. It is always formattable
 * and it is what the browser's zone falls back to, so it is always on offer.
 *
 * The list never changes within a page load and the picker rebuilds it on
 * every render, so it is built once.
 */
const CANONICAL_ZONES: readonly string[] = (() => {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(FALLBACK_TIMEZONE) ? zones : [FALLBACK_TIMEZONE, ...zones];
})();

/** The zones a screen offers, in the order the runtime lists them. */
export const supportedTimezones = (): readonly string[] => CANONICAL_ZONES;

/** Whether this runtime can format times in this zone. */
export const isSupportedTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

/** The browser's zone when this runtime knows it, and UTC when it does not. */
export const browserTimezone = (resolve: TimezoneResolver = resolveFromIntl): string => {
  const zone = resolve();
  return isSupportedTimezone(zone) ? zone : FALLBACK_TIMEZONE;
};
