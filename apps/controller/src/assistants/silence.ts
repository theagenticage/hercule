/**
 * The silence rule for a heartbeat reply. A heartbeat wakes the assistant on
 * a schedule, and most of the time it has nothing to say. It then answers
 * with the token `NO_REPLY`, and the reply is stored as quiet so a client can
 * collapse it.
 */

/** The token an assistant answers with to stay quiet. */
const SILENCE_TOKEN = "NO_REPLY";

/**
 * A reply with `NO_REPLY` and this many characters or more besides is a real
 * message, not a quiet one: the assistant said something worth reading.
 */
export const QUIET_REPLY_MAX_CHARACTERS = 300;

/** A heartbeat reply after the silence rule: its text and whether it is quiet. */
export interface HeartbeatReply {
  readonly text: string;
  readonly quiet: boolean;
}

/**
 * Applies the silence rule to the text of a heartbeat reply and returns the
 * text to store and whether the reply is quiet.
 *
 * - `NO_REPLY` is recognized at the start or the end of the trimmed text. It
 *   is removed, and the text that is left is trimmed.
 * - When `NO_REPLY` was found and fewer than `QUIET_REPLY_MAX_CHARACTERS`
 *   characters are left, the reply is quiet.
 * - When `NO_REPLY` was found and that many or more are left, the reply is
 *   not quiet, and the text is what is left.
 * - Without `NO_REPLY`, the text is returned as it came, and is not quiet.
 *
 * `NO_REPLY` in the middle of the text is not recognized.
 */
export const applyHeartbeatSilenceRule = (text: string): HeartbeatReply => {
  const trimmed = text.trim();
  let remainder: string;
  if (trimmed.startsWith(SILENCE_TOKEN)) {
    remainder = trimmed.slice(SILENCE_TOKEN.length);
  } else if (trimmed.endsWith(SILENCE_TOKEN)) {
    remainder = trimmed.slice(0, -SILENCE_TOKEN.length);
  } else {
    return { text, quiet: false };
  }
  remainder = remainder.trim();
  return { text: remainder, quiet: remainder.length < QUIET_REPLY_MAX_CHARACTERS };
};
