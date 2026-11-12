/**
 * What the Work screen remembers of the board it last drew, in
 * `localStorage`, to play back what changed while the app was closed (the
 * morning replay). One entry per controller and user: a card's id means
 * nothing to another controller, and two people on one machine do not share a
 * board. The entry holds a `BoardSnapshot` of client-core, which keeps where
 * each card stood and why, and nothing the user typed.
 */
import type { BoardSnapshot } from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage } from "@hercule/contract";

/** Returns the `localStorage` key that holds the board `username` last saw on the controller at `controllerUrl`. */
export const buildBoardSnapshotKey = (controllerUrl: string, username: string): string =>
  `work-board-snapshot:${controllerUrl}:${username}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isBoardStage = (value: unknown): value is BoardStage =>
  BOARD_STAGES.some((stage) => stage === value);

/** Returns `value` as a card of the snapshot, or `undefined` when it is not one. */
const readSnapshotCard = (value: unknown): BoardSnapshot["cards"][number] | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, stage, projectId, stageCause } = value;
  if (typeof id !== "string" || !isBoardStage(stage)) return undefined;
  if (projectId !== undefined && typeof projectId !== "string") return undefined;
  if (stageCause !== undefined) {
    if (!isRecord(stageCause)) return undefined;
    const { kind, factId, ref, sessionId, stageRevision, text } = stageCause;
    if (typeof text !== "string") return undefined;
    const base = { id, stage, ...(projectId === undefined ? {} : { projectId }) };
    if (kind === "report") {
      // A report cause stored without a revision cannot be told from the next one: drop the snapshot.
      if (typeof sessionId !== "string" || !Number.isInteger(stageRevision)) return undefined;
      return {
        ...base,
        stageCause: { kind, sessionId, stageRevision: stageRevision as number, text },
      };
    }
    // A snapshot written before reports existed has no `kind`; its causes are all facts.
    if (
      (kind !== undefined && kind !== "fact") ||
      typeof factId !== "number" ||
      !Number.isInteger(factId) ||
      typeof ref !== "string"
    ) {
      return undefined;
    }
    return { ...base, stageCause: { kind: "fact", factId, ref, text } };
  }
  return { id, stage, ...(projectId === undefined ? {} : { projectId }) };
};

/**
 * Returns the snapshot stored under `key`, or `undefined` when there is none.
 * A missing, unreadable or malformed entry reads as none, and so does an entry
 * with a single card that is not what it should be: a snapshot without that
 * card would show it as new on the next visit.
 */
export const readSavedBoardSnapshot = (key: string): BoardSnapshot | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["cards"])) return undefined;
  const cards = parsed["cards"].map(readSnapshotCard);
  if (cards.some((card) => card === undefined)) return undefined;
  return {
    cards: cards.filter((card) => card !== undefined),
    isTruncated: parsed["isTruncated"] === true,
  };
};

/** Stores `snapshot` under `key`. A storage that refuses it loses nothing that matters (the next visit plays no replay), so the failure is ignored. */
export const writeSavedBoardSnapshot = (key: string, snapshot: BoardSnapshot): void => {
  try {
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // The storage is full or denied: the next visit shows the board without a replay.
  }
};
