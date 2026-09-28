/**
 * The sources of the events the controller writes itself. An event from a
 * Connection has the Connection's source; these are the others.
 */

/** The source of every event the controller logs about its own state: audit entries and platform events. */
export const PLATFORM_SOURCE = "platform";

/**
 * The source of every `cron.tick` event. Only the Scheduler writes events with
 * this source, so a tick with any other source did not come from a schedule.
 */
export const CRON_TICK_SOURCE = "cron";

/** The source of every event `event.emit` appends. */
export const MANUAL_SOURCE = "manual";

/**
 * Checks whether an event with this source was written by the controller about
 * itself, as an audit entry, a platform event or a Scheduler tick. Such an
 * event is never amended: a tick's payload names the trigger it fires, so an
 * added ref must not be able to widen what it matches.
 */
export const isControllerSource = (source: string): boolean =>
  source === PLATFORM_SOURCE || source === CRON_TICK_SOURCE;
