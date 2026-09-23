/**
 * Truncates text from a harness to the lengths the protocol accepts. It lives
 * in one module because two adapters truncating the same vendor string to
 * different lengths, or one not truncating at all, would produce a frame the
 * runner cannot encode, and the runner drops an event it cannot encode.
 */
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH } from "@hercule/protocol";

/** Truncates a short value, such as an id, a name or a version, to `MAX_FACT_LENGTH`. */
export const truncateFact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/**
 * Truncates free text a harness wrote to `MAX_MESSAGE_LENGTH`, ending it with
 * `…` when it was cut. The marker matters: a user who reads a truncated command
 * as complete would approve something other than what runs.
 */
export const truncateMessage = (value: string): string =>
  value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : value;
