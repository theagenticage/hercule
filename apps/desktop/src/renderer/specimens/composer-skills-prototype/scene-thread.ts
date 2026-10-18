/**
 * PROTOTYPE (#766). The records the thread is mounted with for a scene: the
 * Fix thread of the thread specimen, with the scene's text in its opening
 * user message and the scene's inputs after its queued input.
 */
import type { Input, TranscriptRow } from "@hercule/contract";
import type { ThreadScreenRecords } from "../shell-page";
import { FIX_THREAD } from "../thread-fixture";
import type { Scene } from "./scenes";

/** The gap between the Fix thread's inputs, in milliseconds. */
const MINUTE = 60_000;

/** The item of the Fix thread's opening user message. */
const OPENING_ITEM_ID = "it-ask";

/**
 * Returns `rows` with the text of the opening user message replaced by
 * `text`. Every other row stays as it is, so the transcript's layout and
 * its times do not move.
 */
const replaceOpeningMessage = (rows: ReadonlyArray<TranscriptRow>, text: string): TranscriptRow[] =>
  rows.map((row): TranscriptRow => {
    if (!("itemId" in row.event) || row.event.itemId !== OPENING_ITEM_ID) return row;
    if (!("detail" in row.event)) return row;
    const { detail } = row.event;
    if (typeof detail !== "object" || detail === null || !("text" in detail)) return row;
    return {
      ...row,
      event: { ...row.event, detail: { ...detail, text } },
    };
  });

/**
 * Returns the id of the queued input that is number `index` among those a
 * scene adds. It is a well-formed UUIDv7, because the client refuses to
 * send a request that names any other kind of id.
 */
export const buildSceneInputId = (index: number): string =>
  `019f0000-0000-7000-8000-${String(index).padStart(12, "0")}`;

/** Returns the queued input a scene adds, shaped like the thread's own queued input. */
const buildQueuedInput = (
  base: Input,
  { text }: NonNullable<Scene["queuedInputs"]>[number],
  index: number,
): Input => ({
  ...base,
  id: buildSceneInputId(index),
  text,
  reason: null,
  createdAt: new Date(Date.parse(base.createdAt) + (index + 1) * MINUTE).toISOString(),
});

/** Returns the Fix thread's records with `scene`'s additions. */
export const buildSceneThread = (scene: Scene): ThreadScreenRecords => ({
  ...FIX_THREAD,
  transcript:
    scene.openingMessage === undefined
      ? FIX_THREAD.transcript
      : replaceOpeningMessage(FIX_THREAD.transcript, scene.openingMessage),
  queuedInputs: [
    ...FIX_THREAD.queuedInputs,
    ...(scene.queuedInputs ?? []).map((each, index) =>
      buildQueuedInput(FIX_THREAD.queuedInputs[0]!, each, index),
    ),
  ],
});
