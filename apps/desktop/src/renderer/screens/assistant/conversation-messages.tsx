/**
 * The blocks of an assistant's Conversation that a thread does not draw, as
 * the Bureau book's desktop/assistant.html draws them: the day stamp, a
 * stored reply, a notice, and the reply the assistant is writing. The
 * owner's messages are the thread's `UserMessage`.
 *
 * Each is presentational and `memo`, as the thread's messages are.
 */
import { memo, type CSSProperties, type JSX } from "react";
import { describeOpenReply, type OpenReplyBlock } from "@hercule/client-core";
import { Face, type Look } from "../../faces";
import { Markdown } from "../session/markdown";
import { AgentFace, OpenMessageText } from "../session/messages";
import type { AttachOpenParagraph } from "../session/use-session-live";

/** The size of a notice's face, in CSS pixels: the book's `data-size="28"`. */
const NOTICE_FACE_SIZE = 28;

/**
 * Returns the style that colours an element in `look`'s hue: tokens.css
 * derives `--who-ink`, which the name and the caret are drawn in, from it.
 */
const buildHueStyle = (look: Look): CSSProperties => ({ "--hue": `var(--hue-${look.hue})` });

/** Renders the day stamp above the first message of a day, such as "Today" or "4 Sep". */
export function DayStamp({ label }: { readonly label: string }): JSX.Element {
  return <div className="stamp">{label}</div>;
}

/**
 * Renders the assistant's name in its hue, then `detail` in small faint
 * text: a stored reply's time, or what the open reply is doing.
 */
function ReplyName({
  name,
  detail,
}: {
  readonly name: string;
  readonly detail: string | undefined;
}): JSX.Element {
  return (
    <div className="msg-name">
      {name} <small>{detail}</small>
    </div>
  );
}

/**
 * Renders a reply the assistant stored: its face, still and idle, then
 * `name` and `time`, then the text as markdown. Only the open reply's face
 * moves, because a stored reply's text is complete.
 */
export const StoredReply = memo(function StoredReply({
  look,
  name,
  time,
  text,
}: {
  readonly look: Look;
  readonly name: string;
  readonly time: string | undefined;
  readonly text: string;
}): JSX.Element {
  return (
    <div className="msg" style={buildHueStyle(look)}>
      <AgentFace look={look} pose="idle" />
      <div className="msg-body">
        <ReplyName name={name} detail={time} />
        <Markdown text={text} />
      </div>
    </div>
  );
});

/**
 * Renders a notice: a line the controller stored about the Conversation,
 * such as a turn that failed, beside the assistant's face in the failed
 * pose, still, with the notice's `time` after the text.
 */
export const Notice = memo(function Notice({
  look,
  text,
  time,
}: {
  readonly look: Look;
  readonly text: string;
  readonly time: string | undefined;
}): JSX.Element {
  return (
    <div className="notice" role="status">
      <Face look={look} pose="failed" size={NOTICE_FACE_SIZE} />
      <span>
        {text}
        {time === undefined ? null : <span className="time">{time}</span>}
      </span>
    </div>
  );
});

/**
 * Renders the reply the assistant is writing: its face in `block.pose`,
 * moving while it works, its `name` and what it is doing, then each text not
 * stored yet. The text being written streams in through
 * `attachOpenParagraph`, with the caret after it. A reply with no text yet
 * shows the caret alone.
 *
 * The caret is drawn by assistant.css, after the paragraph being written,
 * because the live hook replaces that paragraph's children as text streams.
 */
export function OpenReply({
  look,
  name,
  block,
  attachOpenParagraph,
}: {
  readonly look: Look;
  readonly name: string;
  readonly block: OpenReplyBlock;
  readonly attachOpenParagraph: AttachOpenParagraph;
}): JSX.Element {
  return (
    <div className="msg" style={buildHueStyle(look)}>
      <AgentFace look={look} pose={block.pose} />
      <div className="msg-body">
        <ReplyName name={name} detail={describeOpenReply(block)} />
        {block.items.length === 0 ? (
          <p className="streaming" />
        ) : (
          block.items.map((item) =>
            item.itemId === block.openItemId ? (
              <OpenMessageText
                key={item.itemId}
                itemId={item.itemId}
                storedText={item.storedText}
                attachOpenParagraph={attachOpenParagraph}
              />
            ) : (
              <Markdown key={item.itemId} text={item.storedText} />
            ),
          )
        )}
      </div>
    </div>
  );
}
