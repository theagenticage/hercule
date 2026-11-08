import type { WorkBoard, WorkCard } from "@hercule/contract";
import { withoutStageCause } from "./card-move";
import { buildArrivalKey, buildStageMoveKey } from "./hold-back-board";
import { listCardMoves, type CardStageChange, type PlacedCard } from "./list-card-moves";

/**
 * What a client remembers of the board it last drew, to play back what
 * changed while it was away (the morning replay). It holds where each card
 * stood and why, and nothing the user typed: a card that has left the board
 * cannot be drawn from a snapshot anyway, and every other card is drawn from
 * the new read.
 */
export interface BoardSnapshot {
  /** The cards in the order the board drew them, so a card is put back after the card that stood before it. */
  readonly cards: readonly PlacedCard[];
  /** True when the board was cut short by `MAX_BOARD_CARDS`, so it cannot be compared with a whole one. */
  readonly isTruncated: boolean;
}

/** Returns the snapshot of `board`: for each card its id, stage, Project and `stageCause`. */
export const buildBoardSnapshot = (board: WorkBoard): BoardSnapshot => ({
  cards: board.cards.map((card) => ({
    id: card.id,
    stage: card.stage,
    ...(card.projectId === undefined ? {} : { projectId: card.projectId }),
    ...(card.stageCause === undefined ? {} : { stageCause: card.stageCause }),
  })),
  isTruncated: board.truncated,
});

/**
 * The most changes the morning replay plays. They start 1.5 seconds apart, so
 * four take about six seconds, which is as long as a person will watch
 * before the replay is a wait. The changes before them are drawn at once.
 */
export const MOST_REPLAYED_CHANGES = 4;

const SMALL_NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** Returns `n` as a word when it is from one to nine, as the drawing writes small counts, and as digits otherwise. */
const spellCount = (n: number): string => SMALL_NUMBER_WORDS[n - 1] ?? String(n);

/**
 * Returns the sentence that tells what changed between two reads, such as
 * "Since you last looked: two landed, one new". Counts from one to nine are
 * words, larger ones digits. A card that moved into Landed
 * counts as landed, a card that moved anywhere else as moved, and a card that
 * arrived as new. Returns `null` when no card landed, moved or arrived: a card
 * that left the board is not told, because nothing here can say why.
 */
export const summarizeCardMoves = (changes: readonly CardStageChange[]): string | null => {
  const count = (isCounted: (change: CardStageChange) => boolean): number =>
    changes.filter(isCounted).length;
  const parts = [
    [count((change) => change.kind === "moved" && change.to.stage === "landed"), "landed"],
    [count((change) => change.kind === "moved" && change.to.stage !== "landed"), "moved"],
    [count((change) => change.kind === "arrived"), "new"],
  ] as const;
  const words = parts.filter(([n]) => n > 0).map(([n, what]) => `${spellCount(n)} ${what}`);
  return words.length === 0 ? null : `Since you last looked: ${words.join(", ")}`;
};

/** How a client plays back the changes between a snapshot and the first read. */
export interface MorningReplay {
  /** The sentence for the toolbar's line (see `summarizeCardMoves`), counting every change, played or not. */
  readonly summary: string;
  /**
   * The board to start from: the read, with each card that will play still
   * at its stage in the snapshot, and each Task that will arrive left out.
   */
  readonly shown: WorkBoard;
  /**
   * The keys of the changes that play, oldest first: `buildArrivalKey` for a
   * Task that arrived, `buildStageMoveKey` for a card that moved. Pass `shown`
   * as the shown board and the keys as `HoldBackOptions.playedKeys` to
   * `holdBackBoardChanges`, and it holds exactly these changes back.
   */
  readonly playedKeys: readonly string[];
}

/** A change that can play, with the card it is about as the new read has it. */
interface PlayableChange {
  readonly change: CardStageChange;
  readonly card: WorkCard;
  /** When it happened, as the card says: its stage changed, or it was created. Sortable text. */
  readonly at: string;
}

/**
 * Returns how to play back what changed between the board `snapshot`
 * remembers and the first read `latest`, or `undefined` when there is
 * nothing to play: no card arrived or moved, or either board was cut short.
 *
 * Only the net change is known: a card that moved twice plays one move, and a
 * card that moved and came back plays none. The changes play in the order
 * they happened, by the time the card says. When more than
 * `MOST_REPLAYED_CHANGES` happened, the newest play and the older ones are
 * drawn at once, as if the snapshot had been taken after them.
 */
export const planMorningReplay = (
  snapshot: BoardSnapshot,
  latest: WorkBoard,
): MorningReplay | undefined => {
  if (snapshot.isTruncated || latest.truncated) return undefined;
  const changes = listCardMoves(snapshot, latest).filter((change) => change.kind !== "left");
  const summary = summarizeCardMoves(changes);
  if (summary === null) return undefined;

  const latestById = new Map(latest.cards.map((card) => [card.id, card]));
  const playable = changes
    .flatMap((change): PlayableChange[] => {
      const card = latestById.get(change.cardId);
      return card === undefined
        ? []
        : [{ change, card, at: change.kind === "moved" ? card.stageChangedAt : card.createdAt }];
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-MOST_REPLAYED_CHANGES);

  const movedIds = new Set(
    playable.filter(({ change }) => change.kind === "moved").map(({ card }) => card.id),
  );
  const arrivedIds = new Set(
    playable.filter(({ change }) => change.kind === "arrived").map(({ card }) => card.id),
  );
  const snapshotById = new Map(snapshot.cards.map((card) => [card.id, card]));
  // The snapshot's order puts a card back after the card that stood before it.
  const remembered = snapshot.cards.flatMap((placed): WorkCard[] => {
    const card = latestById.get(placed.id);
    if (card === undefined) return [];
    if (!movedIds.has(card.id)) return [card];
    return [
      {
        ...withoutStageCause(card),
        stage: placed.stage,
        ...(placed.stageCause === undefined ? {} : { stageCause: placed.stageCause }),
      },
    ];
  });
  const others = latest.cards.filter(
    (card) => !snapshotById.has(card.id) && !arrivedIds.has(card.id),
  );

  const playedKeys = playable.map(({ change, card }) =>
    change.kind === "moved" ? buildStageMoveKey(card) : buildArrivalKey(card.id),
  );
  return { summary, shown: { ...latest, cards: [...remembered, ...others] }, playedKeys };
};
