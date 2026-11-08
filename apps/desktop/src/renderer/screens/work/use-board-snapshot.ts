import { useEffect, useRef, useState } from "react";
import { buildBoardSnapshot, type BoardSnapshot } from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import { readSavedBoardSnapshot, writeSavedBoardSnapshot } from "./board-snapshot-storage";

/**
 * Returns the snapshot of the board that was stored under `key` when the
 * screen opened, or `undefined` when there was none. It is read once: what
 * the screen stores later is for the next visit.
 */
export const useSavedBoardSnapshot = (key: string): BoardSnapshot | undefined => {
  const [saved] = useState(() => readSavedBoardSnapshot(key));
  return saved;
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
