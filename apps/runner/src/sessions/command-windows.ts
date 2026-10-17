/**
 * The windows of the commands and edits that sessions run in one workspace
 * (spec 19 section 4.1). The edit watch records here what it learns, and reads
 * the windows when it attributes a listing (`edit-attribution.ts`).
 *
 * Every rule here follows from one fact: a window may start early and end
 * late, never the other way round.
 *
 * - **The start** is the earliest gate mark known for the item. A gate runs
 *   before the tool, so its mark is a start. A later mark of the same item
 *   may come from a gate that ran again while the item was already writing.
 * - **A Request** that asks to run an item that has not run parks the
 *   window: the item cannot write until the runner answers. The allow mark,
 *   taken right before the runner sends the allow, is then the start. Only
 *   the first Request of an item parks it.
 * - **The end** is a mark taken when nothing holds the window open any more:
 *   the item completed, and the process it left running ended. A declined
 *   item or Request ran nothing, so its window holds nothing. Nothing else
 *   ends a window before its session exits. A turn's end does not: a harness
 *   can report the end of a turn before the start of a command that runs.
 * - **An unknown start** is the time the session joined the workspace, the
 *   earliest time the item could have started.
 * - **A command that may import content**, such as `git merge`, marks its
 *   window when any gate mark of its item carries its text
 *   (`mayImportContent`). The attribution rule credits nobody for what changed
 *   in such a window.
 */
import type { ProviderEvent } from "@hercule/protocol";
import type { StartMark } from "../edit-marks";
import type { CommandWindow } from "./edit-attribution";
import { mayImportContent } from "./content-imports";

/** What keeps a window open: its item, until it completes, and a process it left running, until that ends. */
type WindowHold = "item" | "process";

type ParkedWindow = {
  /** A Request asks to run the item, and the runner has not answered it yet. */
  readonly _tag: "awaitingAllow";
  readonly sessionId: string;
  readonly requestId: string;
  /** The earliest gate mark, or `undefined` while none is known. */
  readonly startNs: bigint | undefined;
  /** Whether a mark or an event showed the item before its Request. */
  readonly announced: boolean;
  /**
   * Whether the Request was declined. The item then never runs. Its window
   * stays parked until the item's completion, which some harnesses never
   * send, or the session's exit forgets it.
   */
  readonly declined: boolean;
  readonly mayImportContent: boolean;
};

type OpenWindow = {
  readonly _tag: "open";
  readonly sessionId: string;
  /** The earliest gate mark, or the allow mark once `allowed`. `undefined` while neither is known. */
  readonly startNs: bigint | undefined;
  /** Whether the runner allowed the item's Request. The item cannot have run before the allow mark, so later marks change nothing. */
  readonly allowed: boolean;
  readonly holds: ReadonlySet<WindowHold>;
  /** Whether the item's command may write content from elsewhere, such as `git merge`. */
  readonly mayImportContent: boolean;
};

type ClosedWindow = {
  readonly _tag: "closed";
  readonly sessionId: string;
  readonly startNs: bigint | undefined;
  readonly endNs: bigint;
  /** How many listings had started when the window closed. */
  readonly listingsStartedAtClose: number;
  readonly mayImportContent: boolean;
};

type TrackedWindow = ParkedWindow | OpenWindow | ClosedWindow;

/**
 * Checks whether an item of this kind can write files: a shell command or an
 * edit. `tool_call` could write too, but it also covers every read-only tool,
 * and counting it would let a reviewer that only reads hide a worker's commands.
 */
const canWriteFiles = (kind: string): boolean =>
  kind === "command_execution" || kind === "file_change";

/**
 * Builds the key of an item or a Request: its session and its id. A harness
 * gives every tool call of a session its own id, whichever agent makes it.
 */
const buildKey = (sessionId: string, id: string): string => `${sessionId}\0${id}`;

const buildOpenWindow = (
  sessionId: string,
  startNs: bigint | undefined,
  holds: ReadonlyArray<WindowHold>,
  options: { readonly allowed?: boolean; readonly mayImportContent?: boolean } = {},
): OpenWindow => ({
  _tag: "open",
  sessionId,
  startNs,
  allowed: options.allowed ?? false,
  holds: new Set(holds),
  mayImportContent: options.mayImportContent ?? false,
});

/**
 * Creates the windows of one workspace, with none in it.
 *
 * - `takeMark` returns the time now on the file clock.
 * - `takeStartMarks` takes the marks that a session's gates left since the
 *   last call. It is called only where a rule needs the marks: before a
 *   Request's answer, before an end, and before a listing. A streamed token
 *   reads no directory.
 */
export const makeCommandWindows = (options: {
  readonly takeMark: () => bigint;
  readonly takeStartMarks: (sessionId: string) => ReadonlyArray<StartMark>;
}) => {
  const { takeMark, takeStartMarks } = options;
  const windows = new Map<string, TrackedWindow>();
  // Requests on items that already run (`EditMarks.recordRequestOnRunningItem`).
  const requestsOnRunningItems = new Set<string>();
  // A closed window is forgotten by the first successful listing that started
  // after it closed. The count orders them exactly, where two readings of a
  // coarse file clock can tie.
  let listingsStarted = 0;

  /**
   * Records a gate's mark as the start of its item's window, unless an
   * earlier start is known, and marks the window when the mark's command
   * may import content. Whether a window may import content is learnt even from
   * a mark that changes nothing else, because what the command does does not
   * depend on when its gate ran.
   */
  const recordStartMark = (sessionId: string, mark: StartMark): void => {
    const key = buildKey(sessionId, mark.toolUseId);
    const window = windows.get(key);
    const imports = mark.shellCommand !== undefined && mayImportContent(mark.shellCommand);
    if (window === undefined) {
      windows.set(
        key,
        buildOpenWindow(sessionId, mark.startNs, ["item"], { mayImportContent: imports }),
      );
      return;
    }
    if (imports && !window.mayImportContent)
      windows.set(key, { ...window, mayImportContent: true });
    // A closed window keeps its start: the mark of an item that completed
    // can only be one read late.
    if (window._tag === "closed" || (window._tag === "open" && window.allowed)) return;
    if (window.startNs === undefined || mark.startNs < window.startNs) {
      windows.set(key, { ...windows.get(key)!, startNs: mark.startNs });
    }
  };

  /** Records each mark a session's gates left in its marks directory since the last read. */
  const readMarks = (sessionId: string): void => {
    for (const mark of takeStartMarks(sessionId)) recordStartMark(sessionId, mark);
  };

  const closeWindow = (window: OpenWindow, endNs: bigint): ClosedWindow => ({
    _tag: "closed",
    sessionId: window.sessionId,
    startNs: window.startNs,
    endNs,
    listingsStartedAtClose: listingsStarted,
    mayImportContent: window.mayImportContent,
  });

  /** Releases one hold of an open window, and closes the window now when nothing holds it any more. */
  const releaseHold = (key: string, window: OpenWindow, hold: WindowHold): void => {
    const holds = new Set(window.holds);
    holds.delete(hold);
    windows.set(key, holds.size > 0 ? { ...window, holds } : closeWindow(window, takeMark()));
  };

  /**
   * Ends the wait of the window that the Request `requestId` parks, if any.
   * `answer` is the allow mark when the runner allowed the Request, "declined"
   * when the Request was declined, and `undefined` when it ended some other
   * way. An allowed window starts at the allow mark; one that ended another
   * way starts at its gate's mark, as it would have with no Request.
   */
  const endWait = (
    sessionId: string,
    requestId: string,
    answer: bigint | "declined" | undefined,
  ) => {
    readMarks(sessionId);
    for (const [key, window] of windows) {
      if (window._tag !== "awaitingAllow" || window.declined) continue;
      if (window.sessionId !== sessionId || window.requestId !== requestId) continue;
      if (!window.announced && window.startNs === undefined) {
        // No gate announced a window that has neither a mark nor an item, so
        // it is no command, such as a Codex network approval. It is forgotten
        // whatever the answer. If its item does start later, the item opens
        // a window of its own.
        windows.delete(key);
      } else if (answer === "declined") {
        windows.set(key, { ...window, declined: true });
      } else {
        windows.set(
          key,
          buildOpenWindow(sessionId, answer ?? window.startNs, ["item"], {
            allowed: answer !== undefined,
            mayImportContent: window.mayImportContent,
          }),
        );
      }
      return;
    }
  };

  return {
    /**
     * Records what an event shows about a command or edit: a Request that
     * asks to run one, a Request's end, an item that started or completed.
     * Returns whether an item completed with no start known, because no gate
     * mark and no allow mark was recorded for it.
     */
    recordEvent: (event: ProviderEvent): { readonly startWasUnknown: boolean } => {
      const { sessionId } = event;
      switch (event._tag) {
        case "request.opened": {
          const { kind, itemId, requestId } = event.request;
          if (kind !== "command_approval" && kind !== "file_change_approval") break;
          if (requestsOnRunningItems.delete(buildKey(sessionId, requestId))) break;
          const key = buildKey(sessionId, itemId);
          const window = windows.get(key);
          // Only a first Request parks: an allowed or closed item, or one
          // with a running process, may already have written.
          const parks =
            window === undefined ||
            (window._tag === "open" && !window.allowed && !window.holds.has("process"));
          if (parks) {
            windows.set(key, {
              _tag: "awaitingAllow",
              sessionId,
              requestId,
              startNs: window?.startNs,
              announced: window !== undefined,
              declined: false,
              mayImportContent: window?.mayImportContent ?? false,
            });
          }
          break;
        }
        case "request.resolved": {
          const declined =
            "decision" in event && (event.decision === "deny" || event.decision === "cancel");
          endWait(sessionId, event.requestId, declined ? "declined" : undefined);
          break;
        }
        case "item.started": {
          if (!canWriteFiles(event.kind)) break;
          const key = buildKey(sessionId, event.itemId);
          const window = windows.get(key);
          if (window === undefined)
            windows.set(key, buildOpenWindow(sessionId, undefined, ["item"]));
          else if (window._tag === "awaitingAllow")
            windows.set(key, { ...window, announced: true });
          break;
        }
        case "item.completed": {
          if (!canWriteFiles(event.kind)) break;
          readMarks(sessionId);
          const key = buildKey(sessionId, event.itemId);
          const window = windows.get(key);
          // A declined item never ran.
          if (
            event.status === "declined" ||
            (window?._tag === "awaitingAllow" && window.declined)
          ) {
            windows.delete(key);
            break;
          }
          if (window?._tag === "closed") break;
          const open =
            window?._tag === "open"
              ? window
              : buildOpenWindow(sessionId, window?.startNs, ["item"], {
                  mayImportContent: window?.mayImportContent ?? false,
                });
          releaseHold(key, open, "item");
          return { startWasUnknown: open.startNs === undefined };
        }
        default:
          break;
      }
      return { startWasUnknown: false };
    },

    /** Records the mark of a gate that runs in the runner's own process, so it leaves no mark file. */
    recordStartMark,

    /** Records that the Request `requestId` asks about an item that already runs, so it parks nothing. */
    recordRequestOnRunningItem: (sessionId: string, requestId: string): void => {
      requestsOnRunningItems.add(buildKey(sessionId, requestId));
    },

    /**
     * Records that the runner is about to allow the Request `requestId`, and
     * takes the allow mark. Does nothing for a Request that parks no window.
     */
    recordAllow: (sessionId: string, requestId: string): void =>
      endWait(sessionId, requestId, takeMark()),

    /**
     * Records that the tool call `itemId` left a process running that can
     * write files. The window stays open until the process ends. A window
     * that closed opens again with its start, and an item whose window was
     * already forgotten gets one with an unknown start.
     */
    recordProcessStarted: (sessionId: string, itemId: string): void => {
      const key = buildKey(sessionId, itemId);
      const window = windows.get(key);
      if (window?._tag === "open") {
        windows.set(key, { ...window, holds: new Set([...window.holds, "process"]) });
        return;
      }
      // A closed or forgotten window belongs to an item that completed, so
      // only the process holds the window it opens again.
      const holds: ReadonlyArray<WindowHold> =
        window?._tag === "awaitingAllow" ? ["item", "process"] : ["process"];
      windows.set(
        key,
        buildOpenWindow(sessionId, window?.startNs, holds, {
          mayImportContent: window?.mayImportContent ?? false,
        }),
      );
    },

    /** Records that the process of the tool call `itemId` ended, and closes its window when its item completed. */
    recordProcessEnded: (sessionId: string, itemId: string): void => {
      const key = buildKey(sessionId, itemId);
      const window = windows.get(key);
      if (window?._tag === "open") releaseHold(key, window, "process");
    },

    /** Closes every open window of a session that exits now, and forgets its Requests that still wait. */
    closeSessionWindows: (sessionId: string): void => {
      readMarks(sessionId);
      const endNs = takeMark();
      for (const [key, window] of windows) {
        if (window.sessionId !== sessionId) continue;
        if (window._tag === "awaitingAllow") windows.delete(key);
        else if (window._tag === "open") windows.set(key, closeWindow(window, endNs));
      }
    },

    /** Forgets every window and Request of a session, for a session the watch no longer keeps. */
    forgetSessionWindows: (sessionId: string): void => {
      for (const [key, window] of windows) {
        if (window.sessionId === sessionId) windows.delete(key);
      }
      for (const key of requestsOnRunningItems) {
        if (key.startsWith(buildKey(sessionId, ""))) requestsOnRunningItems.delete(key);
      }
    },

    /** Checks whether a window closed and no successful listing has started since: a listing is due. */
    hasClosedWindows: (): boolean =>
      [...windows.values()].some((window) => window._tag === "closed"),

    /** Counts a listing that starts now, and returns its number. */
    startListing: (): number => ++listingsStarted,

    /**
     * Reads the new marks of every session in `sessions`, then returns the
     * windows as the attribution rule reads them. A parked window is left
     * out, because its item has not run. A window whose start is unknown
     * starts when its session joined. Every window belongs to one of
     * `sessions`, because forgetting a session forgets its windows.
     */
    buildCommandWindows: (
      sessions: ReadonlyMap<string, { readonly joinedAtNs: bigint }>,
    ): ReadonlyArray<CommandWindow> => {
      for (const sessionId of sessions.keys()) readMarks(sessionId);
      return [...windows.values()].flatMap((window) =>
        window._tag === "awaitingAllow"
          ? []
          : [
              {
                sessionId: window.sessionId,
                startNs: window.startNs ?? sessions.get(window.sessionId)!.joinedAtNs,
                endNs: window._tag === "closed" ? window.endNs : undefined,
                mayImportContent: window.mayImportContent,
              },
            ],
      );
    },

    /**
     * Forgets the closed windows that closed before the listing `listingNumber`
     * started. Every write they held happened before that listing read the
     * files. Pass `Infinity` to forget every closed window.
     */
    forgetWindowsClosedBefore: (listingNumber: number): void => {
      for (const [key, window] of windows) {
        if (window._tag === "closed" && window.listingsStartedAtClose < listingNumber) {
          windows.delete(key);
        }
      }
    },
  };
};
