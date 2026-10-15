/**
 * How a conversation shows a reply to a Scheduled Wake: a heartbeat the
 * assistant answered with nothing to report folds into one muted line, and
 * every other reply to a wake carries a small label in its meta line.
 */
import type { ConversationMessage, ConversationWake } from "@hercule/contract";

/** The word that names each kind of Scheduled Wake. */
const WAKE_LABELS: Readonly<Record<ConversationWake, string>> = {
  heartbeat: "Heartbeat",
  reminder: "Reminder",
};

/**
 * How a reply is drawn:
 *
 * - `quiet`: collapsed to the one line `summary`. `detail` is what the
 *   assistant wrote besides `NO_REPLY`, shown when the reader expands the
 *   line, or null when it wrote nothing else and there is nothing to expand.
 * - `labelled`: a normal reply whose meta line carries `label`.
 * - `plain`: a normal reply, which no wake opened.
 */
export type ReplyPresentation =
  | { readonly kind: "quiet"; readonly summary: string; readonly detail: string | null }
  | { readonly kind: "labelled"; readonly label: string }
  | { readonly kind: "plain" };

/**
 * Decides how a reply is drawn from its `quiet` and `wake` markers. A quiet
 * reply is always a heartbeat's, so its summary names a heartbeat whatever
 * `wake` says.
 */
export const decideReplyPresentation = (
  message: Pick<ConversationMessage, "text" | "wake" | "quiet">,
): ReplyPresentation => {
  if (message.quiet === true) {
    const detail = message.text.trim();
    return {
      kind: "quiet",
      summary: "Heartbeat - nothing to report",
      detail: detail === "" ? null : detail,
    };
  }
  if (message.wake !== undefined) return { kind: "labelled", label: WAKE_LABELS[message.wake] };
  return { kind: "plain" };
};
