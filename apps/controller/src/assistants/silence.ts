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
const QUIET_REPLY_MAX_CHARACTERS = 300;

/** A heartbeat reply after the silence rule: its text, and `quiet` when the reply stayed quiet. */
interface HeartbeatReply {
  readonly text: string;
  readonly quiet?: true;
}

/**
 * Applies the silence rule to the text of a heartbeat reply and returns the
 * text to store, with `quiet` set when the reply is quiet.
 *
 * - `NO_REPLY` is recognized at the start and at the end of the trimmed text. Each
 *   one is removed, and the text that is left is trimmed.
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
  const withoutStart = trimmed.startsWith(SILENCE_TOKEN)
    ? trimmed.slice(SILENCE_TOKEN.length).trim()
    : trimmed;
  const remainder = withoutStart.endsWith(SILENCE_TOKEN)
    ? withoutStart.slice(0, -SILENCE_TOKEN.length).trim()
    : withoutStart;
  if (remainder === trimmed) return { text };
  return remainder.length < QUIET_REPLY_MAX_CHARACTERS
    ? { text: remainder, quiet: true }
    : { text: remainder };
};
