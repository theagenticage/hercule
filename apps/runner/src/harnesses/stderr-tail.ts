/**
 * Keeps the last lines a harness process wrote to stderr. Codex, pi and
 * Antigravity all put these lines into the message of a failed start or exit,
 * because they are usually the best reason there is.
 */

/** The number of lines from the end of stderr that are kept. */
export const STDERR_TAIL_LINES = 5;

export interface StderrTail {
  /** Returns the kept lines, oldest first. Callable at any time, also while stderr is still open. */
  readonly lastLines: () => ReadonlyArray<string>;
  /**
   * Adds a line that did not come from stderr, to be kept with the others. It
   * counts toward the same limit, so the oldest line is dropped when there are
   * more than `STDERR_TAIL_LINES`.
   */
  readonly remember: (line: string) => void;
  /**
   * Resolves when stderr has ended or failed. A process that has exited has
   * ended its stderr at once, but a descendant that holds the pipe keeps it
   * open, so a caller that must not wait forever limits this wait itself.
   */
  readonly ended: Promise<void>;
}

/**
 * Starts reading `stderr` and keeps its last `STDERR_TAIL_LINES` lines that are
 * not blank. Never fails: a stderr that fails has nothing more to say, and the
 * lines already read are still kept.
 *
 * The pipe is read from the start until it ends, because a pipe nobody reads
 * fills up and then blocks the process.
 */
export const keepStderrTail = (stderr: AsyncIterable<string>): StderrTail => {
  const lines: Array<string> = [];
  const remember = (line: string): void => {
    lines.push(line);
    if (lines.length > STDERR_TAIL_LINES) lines.shift();
  };
  const ended = (async () => {
    try {
      for await (const line of stderr) if (line.trim() !== "") remember(line);
    } catch {
      // A child killed while its stderr is read writes nothing more.
    }
  })();
  return { lastLines: () => lines, remember, ended };
};
