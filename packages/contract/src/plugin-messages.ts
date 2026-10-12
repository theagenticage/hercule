/**
 * The one-line messages the controller shows for a failed plugin call. They
 * live in the contract, beside `MAX_PLUGIN_MESSAGE_LENGTH`, because the
 * plugin host and the connection service both use them, and neither domain
 * may import the other's code.
 */
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { truncateText } from "./excerpts";
import { MAX_PLUGIN_MESSAGE_LENGTH } from "./groups/plugin";

/**
 * Truncates a message to `MAX_PLUGIN_MESSAGE_LENGTH` characters, ending it with
 * "..." if it was cut.
 *
 * A plugin's text has no length limit. Truncating here, where the message is
 * built, rather than in each reader, keeps every message within the published
 * maximum.
 */
export const truncateMessage = (message: string): string =>
  message.length <= MAX_PLUGIN_MESSAGE_LENGTH
    ? message
    : truncateText(message, MAX_PLUGIN_MESSAGE_LENGTH - 3);

/**
 * Returns a one-line message for a failed plugin call: the typed error's
 * message, or the defect's message. Settings shows this line to the user, and
 * a whole stack trace would tell them less than its first sentence.
 */
export const summarizeCause = (cause: Cause.Cause<{ readonly message: string }>): string =>
  truncateMessage(
    Option.match(Cause.findErrorOption(cause), {
      onSome: (error) => error.message,
      onNone: () => {
        const defect = Cause.squash(cause);
        return defect instanceof Error ? defect.message : String(defect);
      },
    }),
  );
