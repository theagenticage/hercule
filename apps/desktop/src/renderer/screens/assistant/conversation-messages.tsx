/**
 * The blocks of an assistant's Conversation that a thread does not draw, as
 * the Bureau book's desktop/assistant.html draws them: the day stamp, a
 * stored reply, a notice, and the reply the assistant is writing. The
 * owner's messages are the thread's `UserMessage`.
 *
 * Each is presentational and `memo`, as the thread's messages are.
 */
import { memo, useState, type JSX } from "react";
import {
  describeMessageMeta,
  describeOpenReply,
  type OpenReplyBlock,
  type QuietRun,
} from "@hercule/client-core";
import { buildHueStyle, Face, type Look } from "../../faces";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { Markdown } from "../session/markdown";
import { AgentFace, OpenMessageText } from "../session/messages";
import type { AttachOpenParagraph } from "../session/use-session-live";

/** The size of a notice's face, in CSS pixels: the book's `data-size="28"`. */
const NOTICE_FACE_SIZE = 28;

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
 * `name` and `time`, then the text as markdown. A reply to a Scheduled Wake
 * has `label` ("Heartbeat" or "Reminder") before the time. Only the open
 * reply's face moves, because a stored reply's text is complete.
 */
export const StoredReply = memo(function StoredReply({
  look,
  name,
  time,
  label,
  text,
}: {
  readonly look: Look;
  readonly name: string;
  readonly time: string | undefined;
  readonly label: string | undefined;
  readonly text: string;
}): JSX.Element {
  return (
    <div className="msg" style={buildHueStyle(look.hue)}>
      <AgentFace look={look} pose="idle" />
      <div className="msg-body">
        <ReplyName
          name={name}
          detail={label === undefined ? time : describeMessageMeta(label, time)}
        />
        <Markdown text={text} />
      </div>
    </div>
  );
});

/**
 * Renders a run of quiet heartbeat replies as one muted line in the
 * message column, drawn as the thread's "Worked for" divider is: the summary
 * in bold, such as "3 heartbeats · nothing to report", the span of times,
 * then a hairline. A run with a note, or with more than one reply, is a
 * button that opens one row per reply under the line; a single reply with
 * nothing to add is a plain line.
 *
 * The open state is local, so it resets when the line scrolls out of the
 * virtualized list. That keeps the Conversation holding no state per run.
 */
export const QuietRunLine = memo(function QuietRunLine({
  run,
}: {
  readonly run: QuietRun;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const canOpen = run.beats.length > 1 || run.beats.some((beat) => beat.note !== null);
  const head = (
    <>
      <b>
        {run.summary}
        {canOpen ? (
          open ? (
            <>
              {" "}
              <span className="chevron">
                <ChevronRightIcon size={12} />
              </span>
            </>
          ) : (
            " ›"
          )
        ) : null}
      </b>
      {run.span === undefined ? null : <span className="quiet-span">{run.span}</span>}
    </>
  );
  if (!canOpen) return <div className="quiet-run">{head}</div>;
  return (
    <>
      <button
        type="button"
        className="quiet-run"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {head}
      </button>
      {open ? (
        <ul className="quiet-beats">
          {run.beats.map((beat) => (
            <li key={beat.id}>
              <span className="quiet-span">{beat.time}</span>
              {beat.note === null ? <span>Nothing to report</span> : <Markdown text={beat.note} />}
            </li>
          ))}
        </ul>
      ) : null}
    </>
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
    <div className="notice">
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
    <div className="msg" style={buildHueStyle(look.hue)}>
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
                storedText={item.rowText}
                attachOpenParagraph={attachOpenParagraph}
              />
            ) : (
              <Markdown key={item.itemId} text={item.rowText} />
            ),
          )
        )}
      </div>
    </div>
  );
}
