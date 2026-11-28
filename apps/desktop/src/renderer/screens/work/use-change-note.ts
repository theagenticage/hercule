import { useCallback, useEffect, useRef, useState } from "react";
import type { HeldChange } from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";

/** How long the toolbar's line keeps saying what happened by itself, in milliseconds. */
const NOTE_SHOWN_MS = 10_000;

/** Returns the sentence for the toolbar's line when `change` shows, or `null` when the card is gone. */
const describeChange = (change: HeldChange, card: WorkCard | undefined): string | null => {
  if (card === undefined) return null;
  if (change.kind === "arrival") return `New: ${card.title}`;
  if (change.kind === "move") return card.stageCause?.text ?? `Moved: ${card.title}`;
  return `${card.failure?.workflowName ?? "A run"} failed`;
};

/**
 * Keeps the sentence for the toolbar's line that names what the board did by
 * itself last, such as "Review PR failed" or the cause of a card's move.
 * `board` is the board as read. Returns the sentence, or `null` when there is
 * nothing to show, and `say`, which puts the sentence for a change that has
 * just been released on the line. It stays for `shownMs` milliseconds, ten
 * seconds when absent.
 */
export const useChangeNote = (
  board: WorkBoard | undefined,
): {
  readonly note: string | null;
  readonly say: (change: HeldChange, shownMs?: number) => void;
} => {
  const [note, setNote] = useState<{ readonly text: string; readonly shownMs: number } | null>(
    null,
  );
  const latestBoard = useRef(board);
  useEffect(() => {
    latestBoard.current = board;
  });

  const say = useCallback((change: HeldChange, shownMs?: number): void => {
    const card = latestBoard.current?.cards.find((each) => each.id === change.cardId);
    const text = describeChange(change, card);
    if (text !== null) setNote({ text, shownMs: shownMs ?? NOTE_SHOWN_MS });
  }, []);

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, note.shownMs);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  return { note: note?.text ?? null, say };
};
