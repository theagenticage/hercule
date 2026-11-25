import * as Schema from "effect/Schema";

/**
 * Why a call to the harness failed:
 *
 * - `refused`: the harness answered with a JSON-RPC error, or reported an
 *   error for a prompt. `code` holds its code and `harnessMessage` its text.
 * - `closed`: the connection is over: the harness exited or closed its output,
 *   a write to it failed, it wrote a line that is not a JSON-RPC message (or
 *   ended in the middle of one), the handshake failed, or the caller closed
 *   the scope.
 * - `unreadable`: the harness answered with a value this client does not know,
 *   such as a new kind of config option, or a prompt reply without a stop
 *   reason. The message names the field and the value, and says to sync the
 *   vendored client.
 * - `timed-out`: no reply came in time. It is not known whether the harness
 *   did what was asked.
 */
export const AcpErrorReason = Schema.Literals(["refused", "closed", "unreadable", "timed-out"]);
export type AcpErrorReason = typeof AcpErrorReason.Type;

/**
 * The failure of every call on an ACP connection. The `message` is written for
 * a person and names the ACP method when one was involved. Text of the harness
 * is cut to a sane length in it, and the header values of the session are
 * replaced by `[hidden]` in it.
 */
export class AcpError extends Schema.TaggedError<AcpError>()("AcpError", {
  reason: AcpErrorReason,
  message: Schema.String,
  /** The JSON-RPC error code. Set only when `reason` is `refused`. */
  code: Schema.optionalKey(Schema.Number),
  /**
   * The text of the harness's error, whole, with the session's header values
   * hidden. Set only when `reason` is `refused`. A caller that tells one
   * refusal from another by its wording, such as "not signed in", reads this
   * and not `message`.
   */
  harnessMessage: Schema.optionalKey(Schema.String),
}) {}
