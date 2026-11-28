/**
 * The morning replay, as the Work board lives it: the snapshot of the board
 * the user last saw is read when the screen opens and stored when the window
 * hides or the screen closes, the plan of what changed since (`planMorningReplay`)
 * is made for the first picture of a visit, its changes start 1.5 seconds
 * apart, and a quiet line sums them up when they have played.
 */
import { useEffect, useRef, useState } from "react";
import { buildBoardSnapshot, planMorningReplay, type HeldChange } from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import { isMotionReduced } from "../../app/motion";
import { readSavedBoardSnapshot, writeSavedBoardSnapshot } from "./board-snapshot-storage";

/** How long after the board is drawn the first change starts, in milliseconds. */
const REPLAY_LEAD_MS = 300;

/** How far apart the changes start, and how long a change's words stay on the toolbar's line, in milliseconds. */
export const REPLAY_GAP_MS = 1500;

const NO_KEYS: readonly string[] = [];
const NO_PLAYED_KEYS: ReadonlySet<string> = new Set();
const NO_DELAYS: ReadonlyMap<string, number> = new Map();

/** What the replay of this visit plays: the sentence that sums it up, and the keys of the changes it plays, oldest first (none under Reduce motion). */
interface VisitReplay {
  readonly summary: string;
  readonly playedKeys: readonly string[];
}

/** What `useMorningReplay` gives the board. */
export interface MorningReplay {
  /**
   * The board the replay starts from, while `isStarting` is true and a replay
   * plays; `undefined` otherwise. The first picture of a visit is drawn from it.
   */
  readonly startBoard: WorkBoard | undefined;
  /** The keys of the changes the replay plays (`MorningReplay.playedKeys` of client-core), for `holdBackBoardChanges` to hold. */
  readonly playedKeys: ReadonlySet<string>;
  /** When each played change starts waiting for a still hand, in milliseconds, by key. */
  readonly startDelays: ReadonlyMap<string, number>;
  /** Whether a snapshot was stored when the screen opened. */
  readonly hasSaved: boolean;
  /** Whether there is a replay to play again. */
  readonly canPlayAgain: boolean;
  /**
   * Returns the sentence that sums up what changed, such as "Since you last
   * looked: two landed, one new", once none of the changes the replay plays is
   * still `held`; `null` before, and when nothing changed. Under Reduce motion
   * nothing plays, so it is there at once.
   */
  readonly summarize: (held: readonly HeldChange[]) => string | null;
}

/**
 * Plans the morning replay for the picture that starts a visit. `isStarting`
 * is true for the render that draws the first picture, which is also the first
 * one after the replay is asked for again; the plan is made then, against
 * `logicalBoard` and the snapshot read when the screen opened, and no other
 * render makes it. `snapshotKey` is where the snapshot is stored
 * (`buildBoardSnapshotKey`).
 */
export const useMorningReplay = ({
  snapshotKey,
  logicalBoard,
  isStarting,
}: {
  readonly snapshotKey: string;
  readonly logicalBoard: WorkBoard | undefined;
  readonly isStarting: boolean;
}): MorningReplay => {
  const [saved] = useState(() => readSavedBoardSnapshot(snapshotKey));
  const [visit, setVisit] = useState<VisitReplay | undefined>(undefined);

  let current = visit;
  let startBoard: WorkBoard | undefined;
  if (isStarting && logicalBoard !== undefined) {
    const plan = saved === undefined ? undefined : planMorningReplay(saved, logicalBoard);
    const isPlayed = plan !== undefined && !isMotionReduced();
    startBoard = isPlayed ? plan.shown : undefined;
    current =
      plan === undefined
        ? undefined
        : { summary: plan.summary, playedKeys: isPlayed ? plan.playedKeys : NO_KEYS };
    setVisit(current);
  }
  const playedKeys = current === undefined ? NO_PLAYED_KEYS : new Set(current.playedKeys);
  const startDelays =
    current === undefined || current.playedKeys.length === 0
      ? NO_DELAYS
      : new Map(
          current.playedKeys.map((key, index) => [key, REPLAY_LEAD_MS + index * REPLAY_GAP_MS]),
        );
  return {
    startBoard,
    playedKeys,
    startDelays,
    hasSaved: saved !== undefined,
    canPlayAgain: current !== undefined && current.playedKeys.length > 0,
    summarize: (held) =>
      current === undefined || held.some((change) => playedKeys.has(change.key))
        ? null
        : current.summary,
  };
};

/** The board last written, so the same board is not written twice. */
interface Written {
  current: WorkBoard | undefined;
}

/** Stores `board` under `key` unless it is not drawn yet, or is the board `written` holds. */
const rememberBoard = (key: string, board: WorkBoard | undefined, written: Written): void => {
  if (board === undefined || board === written.current) return;
  written.current = board;
  writeSavedBoardSnapshot(key, buildBoardSnapshot(board));
};

/**
 * Stores the board as the user saw it, under `key`, for the next visit's
 * morning replay.
 *
 * It writes when the window is hidden, when the page unloads, and when the
 * screen closes, and only when the drawn board is not the one it last wrote.
 * Nothing runs between those moments, and a board that did not change is not
 * written again. It also writes the first board drawn when `hasSaved` is
 * false, so a visit that ends without a clean exit still leaves a board to
 * compare with. `board` is the drawn board, or `undefined` until the first
 * read ends.
 */
export const useRememberDrawnBoard = (
  key: string,
  board: WorkBoard | undefined,
  hasSaved: boolean,
): void => {
  const latest = useRef(board);
  const written = useRef<WorkBoard | undefined>(undefined);
  useEffect(() => {
    latest.current = board;
  });
  useEffect(() => {
    const writeLatest = (): void => {
      rememberBoard(key, latest.current, written);
    };
    const writeWhenHidden = (): void => {
      if (document.visibilityState === "hidden") writeLatest();
    };
    document.addEventListener("visibilitychange", writeWhenHidden);
    window.addEventListener("pagehide", writeLatest);
    return () => {
      document.removeEventListener("visibilitychange", writeWhenHidden);
      window.removeEventListener("pagehide", writeLatest);
      writeLatest();
    };
  }, [key]);
  const hasBoard = board !== undefined;
  useEffect(() => {
    if (hasBoard && !hasSaved) rememberBoard(key, latest.current, written);
  }, [hasBoard, hasSaved, key]);
};
