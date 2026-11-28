/**
 * Keeps the last lines a harness process wrote to stderr. Codex, pi and
 * Antigravity all put these lines into the message of a failed start or exit,
 * because they are usually the best reason there is.
 */

/** The number of lines from the end of stderr that are kept. */
const STDERR_TAIL_LINES = 5;

export interface StderrTail {
  /** Returns the kept lines, oldest first. Callable at any time, also while stderr is still open. */
  readonly lastLines: () => ReadonlyArray<string>;
  /**
   * Adds a line that did not come from stderr, to be kept with the others. It
   * counts toward the same limit, so the oldest line is dropped when there are
   * more than five. The line is kept as it is, without the `formatLine` of
   * `keepStderrTail`.
   */
  readonly appendLine: (line: string) => void;
  /**
   * Resolves when reading stderr reaches its end or fails. The process may
   * have exited before that, with output still in the pipe, and a descendant
   * that holds the pipe keeps it open, so a caller that must not wait forever
   * limits this wait itself. Lines already read stay available either way.
   */
  readonly ended: Promise<void>;
}

/**
 * Starts reading `stderr` and keeps its last five lines that are not blank,
 * each as `formatLine` returns it. `formatLine` runs when a line is read, so a
 * caller that shortens lines never holds the full text. Never fails: when
 * reading stderr fails, the lines already read are still kept.
 *
 * The pipe is read from the start until it ends, because a pipe nobody reads
 * fills up and then blocks the process.
 */
export const keepStderrTail = (
  stderr: AsyncIterable<string>,
  formatLine: (line: string) => string = (line) => line,
): StderrTail => {
  const lines: Array<string> = [];
  const appendLine = (line: string): void => {
    lines.push(line);
    if (lines.length > STDERR_TAIL_LINES) lines.shift();
  };
  const ended = (async () => {
    try {
      for await (const line of stderr) if (line.trim() !== "") appendLine(formatLine(line));
    } catch {
      // The pipe failed, for example because the child was killed while it
      // was read. The lines read before are still worth reporting.
    }
  })();
  return { lastLines: () => lines, appendLine, ended };
};
