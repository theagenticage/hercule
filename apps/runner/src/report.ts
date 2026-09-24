/** Helpers for the timestamp and the error message in the runner's own frames. */
import * as Cause from "effect/Cause";

/** Returns the current time on this machine as an ISO-8601 string. */
export const now = (): string => new Date().toISOString();

/**
 * Returns the first line of a failure's description, cut to `limit`
 * characters to fit the frame field it is sent in. Never returns an empty
 * string: the runner must always report a failure, or the controller would
 * wait until its deadline for a reply the runner could have sent at once.
 */
export const describeCause = (cause: Cause.Cause<unknown>, limit: number): string =>
  (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, limit) || "the runner could not answer";
