/**
 * The blocks of the thread's transcript, one component per kind of
 * `ThreadBlock`, drawn as the Bureau book's session page draws them.
 *
 * Every block is presentational, apart from the shared age clock that
 * `WorkDivider` and `WaitingNote` read, and the finished paragraphs an open
 * message keeps. Every block is `memo`: the transcript draws again each time
 * its visible range changes, and a block whose props did not change is
 * skipped. The props are the block from `buildThreadBlocks`, whose identity
 * changes only when the transcript does, and plain values.
 *
 * Times are drawn by `formatMessageTime` against `today`, the start of the
 * current day, so every block draws again when the day changes and "09:04"
 * becomes "4 Sep 09:04".
 */
import { memo, useState, type JSX } from "react";
import {
  describeMessageMeta,
  describeTurnEnding,
  describeWaitingNote,
  describeWorkStretch,
  formatMessageTime,
  splitStreamingText,
  summarizeWork,
  type EndingBlock,
  type Pose,
  type WorkBlock,
} from "@hercule/client-core";
import { useAgeLabel, useDurationText } from "../../app/age-clock";
import { buildLook, Face } from "../../faces";
import { Mark } from "../../marks";
import { Markdown } from "./markdown";
import type { AttachOpenParagraph } from "./use-thread-live";

/** The size of a face in the transcript, in CSS pixels: the book's `data-size="34"`. */
const FACE_SIZE = 34;

/**
 * Formats the time of `at` for the transcript: "09:04" when it falls on the
 * day that starts at `today` (milliseconds since the epoch), else
 * "4 Sep 09:04". Returns `undefined` when `at` is not a valid time.
 */
const formatBlockTime = (at: string, timezone: string, today: number): string | undefined =>
  formatMessageTime(new Date(at), timezone, new Date(today));

/**
 * Renders the thread's face beside an agent message: seeded by the session id,
 * in `pose`, moving only while working. The face is decorative, because the
 * meta line beside it names the agent.
 */
function AgentFace({
  sessionId,
  pose,
}: {
  readonly sessionId: string;
  readonly pose: Pose;
}): JSX.Element {
  return (
    <Face look={buildLook(sessionId)} pose={pose} size={FACE_SIZE} animated={pose === "working"} />
  );
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
 * - `agent` is the first part of the meta line: the provider and the model.
 * - `pose` is the face's pose: the thread's pose while this message holds the
 *   working face, else `idle`.
 * - `text` is the text the transcript's rows hold. While the message is
 *   `open`, the agent is still writing it: see `OpenMessageText`.
 */
export const AgentMessage = memo(function AgentMessage({
  sessionId,
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
  readonly sessionId: string;
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
      <AgentFace sessionId={sessionId} pose={pose} />
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
function OpenMessageText({
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

/**
 * Renders the working row at the bottom of a running turn while no message
 * holds the working face: the face in the thread's `pose`, and the meta line
 * without a time. Once the agent starts a message, the message takes the
 * face, and the row goes.
 */
export const LiveRow = memo(function LiveRow({
  sessionId,
  agent,
  pose,
}: {
  readonly sessionId: string;
  readonly agent: string;
  readonly pose: Pose;
}): JSX.Element {
  return (
    <div className="msg">
      <AgentFace sessionId={sessionId} pose={pose} />
      <div className="msg-body">
        <div className="msg-meta">{agent}</div>
      </div>
    </div>
  );
});

/**
 * Renders a work stretch's divider: "Worked for 2m 14s ›" and the summary,
 * such as "ran 2 commands", as a button that expands the list of the
 * stretch's items below it.
 *
 * A stretch that still runs reads "Working for 12s ›" and counts on the age
 * clock while it is `onScreen`. `expanded` and `onToggle` belong to the
 * transcript, so a stretch stays open while it scrolls out of the mounted
 * range and back.
 *
 * The button's name is its whole text, the summary included, with commas
 * where the book puts a gap and without the chevron, which a screen reader
 * would read out as a symbol.
 */
export const WorkDivider = memo(function WorkDivider({
  block,
  onScreen,
  expanded,
  onToggle,
}: {
  readonly block: WorkBlock;
  readonly onScreen: boolean;
  readonly expanded: boolean;
  readonly onToggle: (key: string) => void;
}): JSX.Element {
  const label = useDurationText(block.startedAt, block.endedAt === null && onScreen, (now) =>
    describeWorkStretch(block, now),
  );
  const summary = summarizeWork(block.items);
  return (
    <>
      <button
        type="button"
        className="worked"
        aria-expanded={expanded}
        aria-label={[label, ...summary].join(", ")}
        onClick={() => {
          onToggle(block.key);
        }}
      >
        {/* Shut, the label and its chevron are one text, as in the book: the
            browser rounds the width of each piece of text on its own, so a
            chevron of its own would move the summary by 1/128 px, which
            changes how its letters are drawn. Open, the chevron is a box of
            its own, so that it can turn to point down. */}
        {expanded ? (
          <b>
            {`${label} `}
            <span aria-hidden="true" className="chevron">
              ›
            </span>
          </b>
        ) : (
          <b>{`${label} ›`}</b>
        )}
        <span className="tools">
          {summary.map((phrase) => (
            <span key={phrase}>{phrase}</span>
          ))}
        </span>
      </button>
      {expanded ? (
        <ul className="worked-items">
          {block.items.map((item) => (
            <li key={item.itemId}>
              {item.verb}
              {/* A target the item did not report is left out with its separator. */}
              {item.target === "" ? null : (
                <>
                  {" · "}
                  <code>{item.target}</code>
                </>
              )}
              {` · ${item.result}`}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
});

/**
 * Renders the end of a turn that did not complete: "Stopped after 4s",
 * "Failed after 4s" or "Cut short". It is drawn as a divider with nothing to
 * expand, so it has no chevron and is not a button.
 */
export const TurnEnding = memo(function TurnEnding({
  block,
}: {
  readonly block: EndingBlock;
}): JSX.Element {
  return (
    <div className="worked">
      <b>{describeTurnEnding(block)}</b>
    </div>
  );
});

/**
 * Renders the note that the thread waits on the user: "Waiting on you since
 * 09:31 · 10m", from the time the Request opened. The age counts on the age
 * clock while the note is `onScreen`.
 */
export const WaitingNote = memo(function WaitingNote({
  openedAt,
  timezone,
  today,
  onScreen,
}: {
  readonly openedAt: string;
  readonly timezone: string;
  readonly today: number;
  readonly onScreen: boolean;
}): JSX.Element {
  const age = useAgeLabel(openedAt, onScreen);
  return (
    <div className="waiting-note">
      <Mark state="waiting" />
      {describeWaitingNote(formatBlockTime(openedAt, timezone, today), age)}
    </div>
  );
});
