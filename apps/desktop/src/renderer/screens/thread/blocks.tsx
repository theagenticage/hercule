/**
 * The blocks of the thread's transcript that only a thread draws, one
 * component per kind of `ThreadBlock`, drawn as the Bureau book's session
 * page draws them. The pieces a message is made of, which an assistant's
 * Conversation draws too, are in `../session/messages`.
 *
 * Every block is presentational, apart from the finished paragraphs an open
 * message keeps and the shared age clock that `PendingLine`, `WorkDivider`
 * and `WaitingNote` read. Every block is `memo`: the transcript draws again each
 * time its visible range changes, and a block whose props did not change is
 * skipped. The props are the block from `buildThreadBlocks`, whose identity
 * changes only when the transcript does, `Look`s from `buildLook`, which
 * returns the same object for the same seed, and plain values.
 *
 * Times are drawn by `formatMessageTime` against `today`, the start of the
 * current day, so every block draws again when the day changes and "09:04"
 * becomes "4 Sep 09:04".
 */
import { memo, type JSX } from "react";
import {
  describeMessageMeta,
  describePending,
  describeTurnEnding,
  describeWaitingNote,
  describeWorkStretch,
  summarizeWork,
  type EndingBlock,
  type Pose,
  type WorkBlock,
} from "@hercule/client-core";
import { useAgeLabel, useDurationText } from "../../app/age-clock";
import type { Look } from "../../faces";
import { Mark } from "../../marks";
import { Markdown } from "../session/markdown";
import { AgentFace, formatBlockTime, OpenMessageText } from "../session/messages";
import type { AttachOpenParagraph } from "../session/use-session-live";

/**
 * Renders a message the agent wrote: the face, then the meta line "Claude
 * Code · Opus 5.5 · 09:04", then the text as markdown.
 *
 * - `look` is the face's look, from `buildLook`.
 * - `agent` is the first part of the meta line, before the time: the
 *   provider and the model.
 * - `pose` is the face's pose: the session's pose while this message holds
 *   the working face, else `idle`.
 * - `text` is the text the transcript's rows hold. While the message is
 *   `open`, the agent is still writing it: see `OpenMessageText`.
 *
 * An open message has no text until its first word streams in, and a face
 * and meta line with no text beside them would look like a response that
 * has started. So until then the row is hidden and a "Writing…" line stands
 * in its place. Both switch on the paragraph being written: the live hook
 * fills it outside React, so only the stylesheet can see the first word land
 * (see `.msg-pending` in thread.css).
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
    <>
      {open ? (
        <PendingNote label="Writing…" announcement="Writing" className="msg-pending" />
      ) : null}
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
    </>
  );
});

/**
 * Renders a status line in the divider's drawing: `label` on screen, and
 * `announcement` to a screen reader. The two differ because the label may
 * count up every second, and a live region would read each change out; the
 * announcement changes only when the state does. `className` adds to the
 * divider's own class.
 */
function PendingNote({
  label,
  announcement,
  className,
}: {
  readonly label: string;
  readonly announcement: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={className === undefined ? "worked" : `worked ${className}`} role="status">
      <b aria-hidden="true">{label}</b>
      <span className="visually-hidden">{announcement}</span>
    </div>
  );
}

/**
 * Renders the status line at the bottom of a running turn that has drawn
 * nothing yet: "Working for 12s", counted from `since`, or "Starting…" while
 * `since` is `null` because no turn has started. It stands where an agent
 * message will be, in the divider's drawing, so the thread never shows an
 * agent row with no text. The agent's face is drawn only beside text,
 * because the first thing the agent does may be a tool call, not a message.
 *
 * The count runs on the age clock while the line is `onScreen`.
 */
export const PendingLine = memo(function PendingLine({
  since,
  onScreen,
}: {
  readonly since: string | null;
  readonly onScreen: boolean;
}): JSX.Element {
  const label = useDurationText(since ?? "", since !== null && onScreen, (now) =>
    describePending(since, now),
  );
  return <PendingNote label={label} announcement={since === null ? "Starting" : "Working"} />;
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

/**
 * Renders a warning the runner or the harness reported about the agent's
 * work, such as a retried request or an event too large to send whole: the
 * dot, the warning's `message` as the runner wrote it, and its time.
 *
 * The note is quiet, because the work went on: the dot and the message are
 * in the muted ink, not in tomato, which means something failed. The dot is
 * named "Warning", so a screen reader says what kind of note this is.
 */
export const WarningNote = memo(function WarningNote({
  message,
  at,
  timezone,
  today,
}: {
  readonly message: string;
  readonly at: string;
  readonly timezone: string;
  readonly today: number;
}): JSX.Element {
  const time = formatBlockTime(at, timezone, today);
  return (
    <div className="warning-note">
      <i className="dot" role="img" aria-label="Warning" />
      <p>
        {message}
        {time === undefined ? null : <span className="time">{time}</span>}
      </p>
    </div>
  );
});
