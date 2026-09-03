/**
 * The runner role: a daemon that dials the controller and hosts sessions.
 *
 * This module's import graph must never reach the controller, the DB engine,
 * the plugin host, or the web bundle (spec 15 section 3).
 *
 * Stub until the runner ticket lands.
 */
export function run(argv: readonly string[]): void {
  console.log(["runner", ...argv].join(" "));
}
