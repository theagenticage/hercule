/**
 * Decides which message is the session's first, the only one whose context
 * block is read apart from the user's words. The controller appends a block
 * only when it spawns a session, and that spawn is always the session's first
 * input. Any later message keeps its whole text as words: an agent could
 * otherwise hide text behind the fold, or make the app read the ids of things
 * it chose, by typing a block into a message to itself. A subagent's brief is
 * written by its parent agent, so a subagent has no such message.
 *
 * The thread's turns, its blocks and the messages still sending all decide
 * here, so they never read a block differently.
 */
import { splitPromptContext, type Input, type TranscriptRow } from "@hercule/contract";
import { readJsonObject } from "../json-shape";
import type { AgentState } from "./agent-state";
import type { ThreadUserMessage } from "./turns";

type ItemStarted = Extract<TranscriptRow["event"], { _tag: "item.started" }>;

/** The fields of a `ThreadUserMessage` that come from the text that was sent. */
export type SentText = Pick<ThreadUserMessage, "text" | "context">;

/**
 * Splits the text of a sent message into the user's words (`text`) and the
 * context block the controller appended, when there is one. With
 * `isFirstMessage` false, the whole text stays as words.
 */
export const splitSentText = (sentText: string, isFirstMessage: boolean): SentText => {
  if (!isFirstMessage) return { text: sentText };
  const { words, context } = splitPromptContext(sentText);
  return context === undefined ? { text: words } : { text: words, context };
};

/** Returns the `item.started` event of the first `user_message` in `rows`, or `undefined` when there is none. */
const findFirstUserMessage = (rows: readonly TranscriptRow[]): ItemStarted | undefined => {
  const first = rows.find(
    ({ event }) => event._tag === "item.started" && event.kind === "user_message",
  )?.event;
  return first?._tag === "item.started" ? first : undefined;
};

/**
 * Returns the item id of the session's first message in `rows`, whoever sent
 * it. Returns `undefined` when `rows` hold no message yet, and always for a
 * subagent.
 */
export const findFirstMessageItemId = (
  rows: readonly TranscriptRow[],
  agent: AgentState,
): string | undefined => (agent.isSubagent ? undefined : findFirstUserMessage(rows)?.itemId);

/**
 * Splits the text of each input in `sending`, the messages still on their way
 * into the session (oldest first), and returns the results in the same order.
 * Only the oldest one can be the session's first message. It is, when:
 *
 * - the transcript `rows` hold no message yet: the first input of a session
 *   is carried by its start, so it is still sending until its message reaches
 *   the transcript; or
 * - the transcript's first message has the same text: the input is still
 *   sending for a moment after its message reached the transcript. Folding it
 *   shows nothing the transcript's own copy, already split, does not show.
 */
export const splitSendingTexts = (
  rows: readonly TranscriptRow[],
  sending: readonly Input[],
): readonly SentText[] => {
  const first = findFirstUserMessage(rows);
  const firstText = first === undefined ? undefined : readJsonObject(first.detail)?.text;
  return sending.map((input, index) =>
    splitSentText(input.text, index === 0 && (first === undefined || input.text === firstText)),
  );
};
