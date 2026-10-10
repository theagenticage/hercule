/**
 * The prompt text every adapter sends to its harness for one input, built the
 * same way for every harness.
 */
import { appendAttachmentPaths } from "./attachments";
import type { AdapterTurnInput } from "./index";

/**
 * Returns the prompt text an adapter sends to its harness for an input. The
 * pieces come in this order, separated by a blank line:
 *
 * - when another session's agent sent the input, a header that names that
 *   session and the command to answer it, for example
 *   `[Message from session <id>, another agent. To reply: hercule session input <id>]`;
 * - the text of the input;
 * - one line per image naming the file the runner saved it in.
 *
 * A piece that is empty is left out together with its blank line, so an
 * input with no sender and no images returns its text unchanged.
 *
 * Only the harness gets the header and the image lines. The stored input and
 * the `user_message` in the transcript keep the original text, and the
 * transcript shows the sender from `detail.senderSessionId` instead.
 */
export const buildHarnessPrompt = (input: AdapterTurnInput): string => {
  const body = appendAttachmentPaths(input.text, input.attachments);
  if (input.senderSessionId === undefined) return body;
  // The header is true both for a peer and for the session that spawned this
  // one, whose first prompt arrives the same way.
  const header = `[Message from session ${input.senderSessionId}, another agent. To reply: hercule session input ${input.senderSessionId}]`;
  return body === "" ? header : `${header}\n\n${body}`;
};
