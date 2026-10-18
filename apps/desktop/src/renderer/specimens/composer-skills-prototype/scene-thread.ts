/**
 * PROTOTYPE (#766). The records the thread is mounted with for a scene: the
 * Fix thread of the thread specimen, with the scene's sent message at the
 * end of its transcript and the scene's inputs after its queued input.
 */
import type { Input, TranscriptRow } from "@hercule/contract";
import type { ThreadScreenRecords } from "../shell-page";
import { FIX_THREAD } from "../thread-fixture";
import type { Scene } from "./scenes";

const SENT_ITEM_ID = "it-skills";
const MINUTE = 60_000;

/**
 * Returns the rows of a user message with `text`, placed after the last row
 * of `rows`. They copy the rows of the thread's first message, which holds
 * the same two events: the item starting and completing.
 */
const buildSentMessageRows = (
  rows: ReadonlyArray<TranscriptRow>,
  text: string,
): TranscriptRow[] => {
  const last = rows.at(-1)!;
  const copied = rows.filter((row) => "itemId" in row.event && row.event.itemId === "it-ask");
  return copied.map((row, index): TranscriptRow => {
    const position = last.position + 1 + index;
    const at = new Date(Date.parse(last.at) + MINUTE).toISOString();
    return {
      position,
      at,
      event: {
        ...row.event,
        eventId: `event-${String(position)}`,
        at,
        itemId: SENT_ITEM_ID,
        detail: { text },
      } as TranscriptRow["event"],
    };
  });
};

/** Returns the queued input a scene adds, shaped like the thread's own queued input. */
const buildQueuedInput = (
  base: Input,
  { text, refusal }: NonNullable<Scene["queuedInputs"]>[number],
  index: number,
): Input => ({
  ...base,
  id: `in-skill-${String(index)}`,
  text,
  reason: refusal ?? null,
  createdAt: new Date(Date.parse(base.createdAt) + (index + 1) * MINUTE).toISOString(),
});

/** Returns the Fix thread's records with `scene`'s additions. */
export const buildSceneThread = (scene: Scene): ThreadScreenRecords => ({
  ...FIX_THREAD,
  transcript:
    scene.sentMessage === undefined
      ? FIX_THREAD.transcript
      : [
          ...FIX_THREAD.transcript,
          ...buildSentMessageRows(FIX_THREAD.transcript, scene.sentMessage),
        ],
  queuedInputs: [
    ...FIX_THREAD.queuedInputs,
    ...(scene.queuedInputs ?? []).map((each, index) =>
      buildQueuedInput(FIX_THREAD.queuedInputs[0]!, each, index),
    ),
  ],
});
