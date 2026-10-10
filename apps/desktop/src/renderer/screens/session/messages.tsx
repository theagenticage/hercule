/**
 * The pieces of a message that the thread's transcript and an assistant's
 * Conversation both draw, as the Bureau book's session page draws them: the
 * user's bubble, the agent's face beside a message, and the text of a
 * message the agent is still writing. The agent's message itself differs
 * between the two: the thread's is in `../thread/blocks`, the Conversation's
 * reply in `../assistant/conversation-messages`.
 *
 * Every piece is presentational, apart from the finished paragraphs an open
 * message keeps. The user's bubble is `memo`: one whose props did not change
 * is skipped when the list around it draws again.
 *
 * Times are drawn by `formatMessageTime` against `today`, the start of the
 * current day, so every message draws again when the day changes and "09:04"
 * becomes "4 Sep 09:04".
 */
import { memo, useState, type JSX } from "react";
import {
  formatMessageTime,
  splitStreamingText,
  type Pose,
  type SenderReading,
} from "@hercule/client-core";
import type { Attachment } from "@hercule/contract";
import { buildHueStyle, Face, type Look } from "../../faces";
import { SentImages } from "../attachments/sent-images";
import { Markdown } from "./markdown";
import { buildSenderLook, SenderChip } from "./sender-chip";
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

/**
 * Renders a message sent into the session: the images sent with it, then
 * the bubble, as markdown with its line breaks kept, and its time under it.
 * A message sent with images and no text draws no bubble. A message steered
 * into the running turn reads "Steered" before its time.
 *
 * `sender` is left out for a message the user sent. For a message another
 * session's agent sent, it is how to show that agent: a chip with its face
 * and name above the bubble, and the bubble tinted in its hue. The message is
 * then a group named "Message from" and the agent's name, so a screen reader
 * never takes it for the user's. While the agent is still being read,
 * `sender` is `"loading"`: the chip's row is held empty, so the bubble does
 * not move when the name arrives, and nothing names a sender that may be
 * wrong.
 */
export const UserMessage = memo(function UserMessage({
  text,
  attachments,
  at,
  timezone,
  today,
  steered = false,
  sender,
}: {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly at: string;
  readonly timezone: string;
  readonly today: number;
  readonly steered?: boolean;
  readonly sender?: SenderReading | "loading";
}): JSX.Element {
  const time = formatBlockTime(at, timezone, today);
  const content = (
    <>
      {attachments.length === 0 ? null : <SentImages attachments={attachments} />}
      {text === "" ? null : (
        <div className="bubble">
          <Markdown text={text} breaks />
        </div>
      )}
      <div className="bubble-meta">
        {steered ? (time === undefined ? "Steered" : `Steered · ${time}`) : time}
      </div>
    </>
  );
  if (sender === undefined) {
    return (
      <div className="msg--me">
        <div>{content}</div>
      </div>
    );
  }
  if (sender === "loading") {
    return (
      <div className="msg--me">
        <div>
          <div className="msg-sender" />
          {content}
        </div>
      </div>
    );
  }
  const look = buildSenderLook(sender);
  return (
    <div
      className="msg--me msg--agent"
      style={buildHueStyle(look.hue)}
      role="group"
      aria-label={`Message from ${sender.label}`}
    >
      <div>
        <div className="msg-sender">
          <SenderChip sender={sender} look={look} />
        </div>
        {content}
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
