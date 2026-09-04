/**
 * The browser's own IANA timezone.
 *
 * Setup sends it silently so the controller has a timezone from its first
 * minute, and the timezone step of onboarding offers it as the answer to
 * confirm. The resolver is a parameter so a test can name a zone.
 */

/** Where the zone comes from: the browser, or whatever a test hands in. */
export type TimezoneResolver = () => string;

const resolveFromIntl: TimezoneResolver = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const browserTimezone = (resolve: TimezoneResolver = resolveFromIntl): string => resolve();
