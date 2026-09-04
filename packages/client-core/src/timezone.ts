/**
 * The IANA zones this runtime knows, and which one the browser is in.
 *
 * `Intl.supportedValuesOf("timeZone")` is the closed list the same runtime's
 * `Intl.DateTimeFormat` will accept, so a zone taken from it can always be
 * formatted. Every screen that writes the timezone setting picks from this
 * list rather than accepting free text: an unknown zone throws wherever a time
 * is read, which is every screen inside the shell.
 *
 * The browser's own zone is checked against the list before it is offered. A
 * runtime that reports a zone it does not itself list is answering with
 * something it cannot format, so the answer becomes UTC - shown on the
 * onboarding step for the user to confirm or change, never sent silently.
 *
 * The resolver is a parameter so a test can name a zone.
 */

/** Where the zone comes from: the browser, or whatever a test hands in. */
export type TimezoneResolver = () => string;

const resolveFromIntl: TimezoneResolver = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The zone offered when the runtime's own answer is not one it knows. */
export const FALLBACK_TIMEZONE = "UTC";

/** Every IANA zone this runtime can format, in the order it lists them. */
export const supportedTimezones = (): readonly string[] => Intl.supportedValuesOf("timeZone");

/** Whether this runtime can format times in this zone. */
export const isSupportedTimezone = (timezone: string): boolean =>
  supportedTimezones().includes(timezone);

/** The browser's zone when this runtime knows it, and UTC when it does not. */
export const browserTimezone = (resolve: TimezoneResolver = resolveFromIntl): string => {
  const zone = resolve();
  return isSupportedTimezone(zone) ? zone : FALLBACK_TIMEZONE;
};
