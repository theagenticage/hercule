/**
 * Keeps the end of a child process's output and turns it into the message a
 * user reads when the process failed. A setup command and a workspace action
 * build their failure messages the same way.
 */
import { MAX_MESSAGE_LENGTH } from "@hercule/protocol";

/**
 * How many of the last lines of a process's output the user is shown. The end
 * of the output usually shows why the process failed.
 */
const OUTPUT_TAIL_LINES = 20;

/** The most output of one process kept in memory while it runs. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * Reads a stream to its end into `held.text`, keeping only the last
 * `OUTPUT_TAIL_BYTES`. An install log can run to megabytes and only its end is
 * ever read, so older output is dropped as it arrives. Two streams may write
 * into the same holder, and the output then stays in the order it arrived.
 */
export const drainTail = async (
  stream: ReadableStream<Uint8Array>,
  held: { text: string },
): Promise<void> => {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    held.text = (held.text + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_TAIL_BYTES);
  }
};

/**
 * Returns a failure message: the sentence that says why, followed by the last
 * lines of the process's output. The message is cut to the length a frame's
 * message field accepts.
 */
export const buildTailMessage = (why: string, output: string): string => {
  const lines = output.split("\n").filter((line) => line.length > 0);
  return [why, ...lines.slice(-OUTPUT_TAIL_LINES)].join("\n").slice(0, MAX_MESSAGE_LENGTH);
};
