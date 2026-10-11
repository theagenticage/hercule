/**
 * Truncates text from a harness to the lengths the protocol accepts. It lives
 * in one module because two adapters truncating the same vendor string to
 * different lengths, or one not truncating at all, would produce a frame the
 * runner cannot encode, and the runner drops an event it cannot encode.
 */
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH } from "@hercule/protocol";

/**
 * Returns `value` unchanged when it fits in `maxLength` UTF-16 code units, and
 * otherwise its start ended with `…`, at most `maxLength` code units in all.
 * The cut never splits a surrogate pair: an emoji cut in half would leave a
 * lone surrogate, which a surface draws as garbage.
 */
export const truncateWithMarker = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  const kept = value.slice(0, maxLength - 1);
  const last = kept.charCodeAt(kept.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return `${isHighSurrogate ? kept.slice(0, -1) : kept}…`;
};

/**
 * Truncates a short value, such as an id, a name, a version or a path, to
 * `MAX_FACT_LENGTH`, ending it with `…` when it was cut. The marker matters: a
 * cut value read as complete misleads the user, as a cut path can name a
 * different file than the one the agent reads.
 */
export const truncateFact = (value: string): string => truncateWithMarker(value, MAX_FACT_LENGTH);

/**
 * Truncates free text a harness wrote to `MAX_MESSAGE_LENGTH`, ending it with
 * `…` when it was cut. The marker matters: a user who reads a truncated command
 * as complete would approve something other than what runs.
 */
export const truncateMessage = (value: string): string =>
  truncateWithMarker(value, MAX_MESSAGE_LENGTH);
