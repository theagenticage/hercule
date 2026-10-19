import * as Schema from "effect/Schema";

/**
 * The failure of `ProviderAdapter.sendInput` when the harness cannot take this
 * input into the turn that is running, but would run it as the next turn.
 *
 * It is a separate type from the plain-string failure because the supervisor
 * treats it differently. A plain string means the input failed, so the
 * supervisor also reports a `runtime.error` in the thread. This refusal is an
 * expected deferral: the input stays queued and runs when the turn ends, so
 * the supervisor only answers the controller with `ok: false` and this
 * message, and the thread shows nothing.
 *
 * The message is shown to the user as written, so it says what happens to the
 * input.
 */
export class SteerRefused extends Schema.TaggedError<SteerRefused>()("SteerRefused", {
  message: Schema.String,
}) {}

/**
 * Returns the message of a `SteerRefused` for an input that has a skill and
 * reaches a session in the middle of a turn. `harnessName` is the name the
 * user knows the harness by, such as "Claude" or "Codex". The message says
 * what happens to the input, because the user sees it as written.
 */
export const buildSkillSteerRefusedMessage = (harnessName: string): string =>
  `Not steered: ${harnessName} can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.`;
