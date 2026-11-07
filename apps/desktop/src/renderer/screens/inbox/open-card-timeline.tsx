import type { JSX, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  describeTimelineAge,
  type TimelineLine,
  type TimelineOverflow,
} from "@hercule/client-core/inbox";
import { PluginMark } from "../../marks";

/** Renders the words of one line: its sentence, then the thing it is about or the person it names, small. */
function LineText({ line }: { readonly line: TimelineLine }): JSX.Element {
  const resolved = line.signal !== undefined && !line.signal.isOpen;
  return (
    <span className="open-card-text">
      {line.say}
      {line.identifier !== undefined && <small>{line.identifier}</small>}
      {line.person !== undefined && <small>{line.person}</small>}
      {resolved && line.signal?.outcome !== undefined && <q>{line.signal.outcome}</q>}
    </span>
  );
}

/** Renders one line: its dot or the mark of the thing it is about, its words, its age, and the answers when it is the open line. */
function TimelineItem({
  line,
  now,
  plugins,
  isOpened,
  onToggle,
  renderAnswers,
}: {
  readonly line: TimelineLine;
  readonly now: Date;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly isOpened: boolean;
  readonly onToggle: (signalId: string) => void;
  readonly renderAnswers: (signalId: string) => ReactNode;
}): JSX.Element {
  const { signal } = line;
  const isResolved = signal !== undefined && !signal.isOpen;
  const isSnoozed = signal?.isSnoozed === true;
  const classes = [
    "open-card-signal",
    line.isLatest ? "is-latest" : "",
    line.isLinked ? "is-linked" : "",
    isResolved ? "is-resolved" : "",
    isSnoozed ? "is-snoozed" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
  const when = isSnoozed ? (
    <small className="open-card-snoozed">Snoozed</small>
  ) : (
    <time dateTime={line.at}>{describeTimelineAge(line.at, now)}</time>
  );
  const row = (
    <>
      <LineText line={line} />
      {when}
    </>
  );
  return (
    <li className={classes} data-tone={line.tone}>
      {line.markPluginId === undefined ? (
        <span className="signal-dot" />
      ) : (
        <span className="signal-from">
          <PluginMark pluginId={line.markPluginId} plugins={plugins} size={12} />
        </span>
      )}
      {signal !== undefined && signal.isOpen ? (
        <button
          type="button"
          className="open-card-signal-row"
          aria-expanded={isOpened}
          onClick={() => {
            onToggle(signal.id);
          }}
        >
          {row}
        </button>
      ) : (
        <div className="open-card-signal-row">{row}</div>
      )}
      {isOpened && signal !== undefined && renderAnswers(signal.id)}
    </li>
  );
}

/**
 * Renders the timeline of the open card: what happened to the thing and to
 * the things linked to it, oldest first, each line with its sentence and how
 * long ago. A line of a signal that has not ended opens to its answers.
 *
 * - `lines` and `overflow` are `buildOpenTimeline`'s and
 *   `describeTimelineOverflow`'s answers. A line that is `isLatest` is drawn in
 *   ink, or in its tone. A resolved line is faint and says what ended it, a
 *   snoozed line says "Snoozed" where its age would be, and a line about a
 *   linked thing is quiet, with that thing's mark.
 * - `overflow` stands before the first line. "and 12 more open" calls
 *   `onSeeInIntake`, which shows the thing's group on Intake; "and 12 older"
 *   is plain words.
 * - `openLineId` is the signal whose answers show, under its line. `answers`
 *   draws them. `onToggleLine` is called with a line's signal when it is pressed.
 * - `now` is the time the ages are counted to.
 */
export function OpenCardTimeline({
  lines,
  overflow,
  now,
  plugins,
  openLineId,
  onToggleLine,
  onSeeInIntake,
  answers,
}: {
  readonly lines: readonly TimelineLine[];
  readonly overflow: TimelineOverflow | undefined;
  readonly now: Date;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly openLineId: string | undefined;
  readonly onToggleLine: (signalId: string) => void;
  readonly onSeeInIntake: () => void;
  readonly answers: (signalId: string) => ReactNode;
}): JSX.Element {
  return (
    <section className="open-card-timeline" aria-label="Timeline">
      <ol className="open-card-signals">
        {overflow !== undefined && (
          <li className="open-card-more">
            {overflow.kind === "open" ? (
              <button type="button" onClick={onSeeInIntake}>
                {overflow.words}
              </button>
            ) : (
              <span>{overflow.words}</span>
            )}
          </li>
        )}
        {lines.map((line) => (
          <TimelineItem
            key={line.key}
            line={line}
            now={now}
            plugins={plugins}
            isOpened={line.signal !== undefined && line.signal.id === openLineId}
            onToggle={onToggleLine}
            renderAnswers={answers}
          />
        ))}
      </ol>
    </section>
  );
}
