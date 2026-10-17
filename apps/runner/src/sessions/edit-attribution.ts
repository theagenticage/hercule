/**
 * The rule that ties a changed file to the session that changed it, for the
 * edits that shell commands make (spec 19 section 4.1).
 *
 * A command has a window: the time from just before it ran to just after it
 * finished, on the kernel's file clock. A file's ctime is the kernel's stamp
 * of its last write, on the same clock. A file belongs to the session whose
 * command window holds its ctime.
 *
 * The rule is built on one fact: a write is credited to the wrong session only
 * if it falls outside the window of the command that made it. So a window may
 * start early and end late, and never the other way round. Every choice in
 * this file and in the watch that uses it follows from that:
 *
 * - Windows are inclusive at both ends. On Linux the file clock moves in
 *   ticks of a few milliseconds, so a write often ties with a mark.
 * - A window with no end yet holds everything after its start.
 * - A window whose start is unknown starts at the earliest time the command
 *   could have started. For writes by gated tools, a window that holds too
 *   much can only make files ambiguous, never wrong. A write that no gate
 *   announced, such as one by the user's editor, is credited to a session
 *   whose window holds it alone.
 * - Ambiguous files are dropped, never guessed.
 */

/** The window of one command or edit of a session, on the file clock, in nanoseconds. */
export interface CommandWindow {
  readonly sessionId: string;
  /**
   * A time at or before the command started. When the command's own start is
   * unknown, the caller passes the earliest time it could have started, such
   * as when its session joined.
   */
  readonly startNs: bigint;
  /** A time at or after the command finished, or `undefined` while it may still be running. */
  readonly endNs: bigint | undefined;
}

/** What the rule decided about the files of one listing. */
export interface Attribution<File> {
  /** Files that exactly one session's windows hold. */
  readonly credited: ReadonlyArray<{ readonly file: File; readonly sessionId: string }>;
  /** Files that windows of two or more sessions hold. Nobody can be credited. */
  readonly ambiguous: ReadonlyArray<{
    readonly file: File;
    readonly sessionIds: ReadonlySet<string>;
  }>;
  /** Files that no window holds: the user's editor, an ungated process, or an earlier write. */
  readonly unattributed: ReadonlyArray<File>;
}

/** Tells whether a window and the time from `fromNs` to `toNs`, both included, have a moment in common. */
const overlaps = (window: CommandWindow, fromNs: bigint, toNs: bigint): boolean =>
  window.startNs <= toNs && (window.endNs === undefined || window.endNs >= fromNs);

/**
 * Decides, for each changed file of one listing, which session made the
 * change. Each change happened at a time or within a span of time:
 *
 * - A file that exists changed at its ctime.
 * - A deleted file has no ctime. It was there when the previous listing
 *   started (`previousListingStartedAtNs`) and gone when this listing read
 *   the files (`scannedAtNs`), so it went somewhere in between. Without the
 *   upper bound, a command that started after this listing read the files
 *   would hold the deletion.
 * - A file whose ctime is earlier than the start of the previous listing was
 *   moved, not written: a rename keeps the ctime of each file inside a moved
 *   directory, so `mv old-dir new-dir` brings in new paths with old ctimes.
 *   The move happened in the same span as a deletion, and is attributed the
 *   same way. A ctime equal to that start may be a write the previous listing
 *   missed, so it still counts as the time of the change.
 *
 * A file goes to the one session that has a window overlapping the time of
 * its change; two windows of the same session are one session. When two or
 * more sessions qualify the file is ambiguous, and when none does it is
 * unattributed.
 */
export const attributeChangedFiles = <File extends { readonly ctimeNs: bigint | null }>(
  files: ReadonlyArray<File>,
  windows: ReadonlyArray<CommandWindow>,
  times: { readonly previousListingStartedAtNs: bigint; readonly scannedAtNs: bigint },
): Attribution<File> => {
  const credited: Array<{ file: File; sessionId: string }> = [];
  const ambiguous: Array<{ file: File; sessionIds: ReadonlySet<string> }> = [];
  const unattributed: Array<File> = [];
  for (const file of files) {
    const [fromNs, toNs] =
      file.ctimeNs === null || file.ctimeNs < times.previousListingStartedAtNs
        ? [times.previousListingStartedAtNs, times.scannedAtNs]
        : [file.ctimeNs, file.ctimeNs];
    const sessionIds = new Set(
      windows.filter((window) => overlaps(window, fromNs, toNs)).map((window) => window.sessionId),
    );
    if (sessionIds.size === 1) credited.push({ file, sessionId: [...sessionIds][0]! });
    else if (sessionIds.size > 1) ambiguous.push({ file, sessionIds });
    else unattributed.push(file);
  }
  return { credited, ambiguous, unattributed };
};
