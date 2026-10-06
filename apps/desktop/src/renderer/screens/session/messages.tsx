/**
 * The messages of a session on screen: the user's bubble and the agent's
 * message, drawn as the Bureau book's session page draws them. The thread's
 * transcript and an assistant's Conversation both draw them.
 *
 * Every message is presentational, apart from the finished paragraphs an
 * open message keeps. Every message is `memo`: one whose props did not
 * change is skipped when the list around it draws again. The props are plain
 * values, and a `Look` from `buildLook`, which returns the same object for
 * the same seed.
 *
 * Times are drawn by `formatMessageTime` against `today`, the start of the
 * current day, so every message draws again when the day changes and "09:04"
 * becomes "4 Sep 09:04".
 */
import { memo, useState, type JSX } from "react";
import {
  describeMessageMeta,
  formatMessageTime,
  splitStreamingText,
  type Pose,
} from "@hercule/client-core";
import { Face, type Look } from "../../faces";
import { Markdown } from "./markdown";
import type { AttachOpenParagraph } from "./use-session-live";
import "./messages.css";

/** The size of a face beside a message, in CSS pixels: the book's `data-size="34"`. */
const FACE_SIZE = 34;

/**
 * Formats the time of `at` for a message: "09:04" when it falls on the day
 * that starts at `today` (milliseconds since the epoch), else "4 Sep 09:04".
 * Returns `undefined` when `at` is not a valid time.
 */
export const formatBlockTime = (at: string, timezone: string, today: number): string | undefined =>
  formatMessageTime(new Date(at), timezone, new Date(today));

/**
 * Renders the agent's face beside a message, with `look`, in `pose`, moving
 * only while working. The face is decorative, because the meta line beside it
 * names the agent.
 */
export function AgentFace({
  look,
  pose,
}: {
  readonly look: Look;
  readonly pose: Pose;
}): JSX.Element {
  return <Face look={look} pose={pose} size={FACE_SIZE} animated={pose === "working"} />;
}

/** Renders a message the user sent: the bubble, as markdown with its line breaks kept, and its time under it. */
export const UserMessage = memo(function UserMessage({
  text,
  at,
  timezone,
  today,
}: {
  readonly text: string;
  readonly at: string;
  readonly timezone: string;
  readonly today: number;
}): JSX.Element {
  return (
    <div className="msg--me">
      <div>
        <div className="bubble">
          <Markdown text={text} breaks />
        </div>
        <div className="bubble-meta">{formatBlockTime(at, timezone, today)}</div>
      </div>
    </div>
  );
});

/**
 * Renders a message the agent wrote: the face, then the meta line "Claude
 * Code · Opus 5.5 · 09:04", then the text as markdown.
 *
 * - `look` is the face's look: the thread's, or the assistant's.
 * - `agent` is the first part of the meta line, before the time: the
 *   provider and the model on a thread, the assistant's name in a
 *   Conversation.
 * - `pose` is the face's pose: the session's pose while this message holds
 *   the working face, else `idle`.
 * - `text` is the text the transcript's rows hold. While the message is
 *   `open`, the agent is still writing it: see `OpenMessageText`.
 */
export const AgentMessage = memo(function AgentMessage({
  look,
  itemId,
  agent,
  text,
  startedAt,
  timezone,
  today,
  pose,
  open,
  attachOpenParagraph,
}: {
  readonly look: Look;
  readonly itemId: string;
  readonly agent: string;
  readonly text: string;
  readonly startedAt: string;
  readonly timezone: string;
  readonly today: number;
  readonly pose: Pose;
  readonly open: boolean;
  readonly attachOpenParagraph: AttachOpenParagraph;
}): JSX.Element {
  const meta = describeMessageMeta(agent, formatBlockTime(startedAt, timezone, today));
  return (
    <div className="msg">
      <AgentFace look={look} pose={pose} />
      <div className="msg-body">
        <div className="msg-meta">{meta}</div>
        {open ? (
          <OpenMessageText
            itemId={itemId}
            storedText={text}
            attachOpenParagraph={attachOpenParagraph}
          />
        ) : (
          <Markdown text={text} />
        )}
      </div>
    </div>
  );
});

/**
 * Renders the text of a message the agent is still writing: its finished
 * paragraphs as markdown, then the paragraph being written as plain text.
 * `storedText` is the text the transcript's rows hold.
 *
 * The live hook paints the paragraph being written, from the stored text and
 * the tail that streamed in after it, and hands the message each paragraph
 * that finishes. A paragraph is drawn as markdown only once it has finished,
 * because the text arrives cut anywhere: rows every 4 KB, even inside a word,
 * and tokens even inside a code block. Markdown drawn from a cut would end
 * its paragraph at the cut.
 */
export function OpenMessageText({
  itemId,
  storedText,
  attachOpenParagraph,
}: {
  readonly itemId: string;
  readonly storedText: string;
  readonly attachOpenParagraph: AttachOpenParagraph;
}): JSX.Element {
  const [settledText, setSettledText] = useState(() => splitStreamingText(storedText).settled);
  return (
    <>
      <Markdown text={settledText} />
      {/* The live hook writes this paragraph's text; React keeps the element empty. */}
      <p
        className="streaming"
        ref={(element) =>
          attachOpenParagraph(element, {
            itemId,
            storedText,
            settledText,
            onSettle: setSettledText,
          })
        }
      />
    </>
  );
}
