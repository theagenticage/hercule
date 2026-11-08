import type { JSX, ReactNode } from "react";
import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import {
  describeLockedRow,
  formatTargetDate,
  readEntityPluginId,
  type PlaceRow,
} from "@hercule/client-core/desk";
import type { OpenCardWords, PlaceView } from "@hercule/client-core/inbox";
import type { EntityStatus } from "@hercule/contract";
import { CloseIcon } from "../../icons/close";
import { ExternalIcon } from "../../icons/external";
import { PluginMark } from "../../marks";
import { ProgressBar, RelationRows, StatusShape } from "../desk";
import { CardFactText, CardStatus } from "./card-parts";
import "./open-card.css";

/** Renders the head of the sheet: the plugin's mark, the title at 20px, and the close button. */
function OpenCardHead({
  pluginId,
  plugins,
  title,
  meta,
  onClose,
}: {
  readonly pluginId: string;
  readonly plugins: readonly PluginIdentity[];
  readonly title: string;
  readonly meta: readonly string[];
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <header className="open-card-head">
      <span className="open-card-mark">
        <PluginMark pluginId={pluginId} plugins={plugins} size={20} />
      </span>
      <h2 className="open-card-title">{title}</h2>
      <button
        type="button"
        className="icon-btn icon-btn--sm open-card-close"
        aria-label="Close"
        onClick={onClose}
      >
        <CloseIcon size={13} />
      </button>
      <p className="open-card-meta">
        {meta.map((part, index) => (
          <span key={index}>{part}</span>
        ))}
      </p>
    </header>
  );
}

/** Renders a section of the sheet under a quiet heading, such as "Part of". */
export function OpenCardSection({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="open-card-section">
      <h3 className="open-card-heading">{heading}</h3>
      {children}
    </section>
  );
}

/** Renders a priority level as three bars of which `level` are lit. */
function PriorityBars({ level }: { readonly level: number }): JSX.Element {
  return (
    <span className="open-card-bars" role="img" aria-label={`Priority ${String(level)} of 3`}>
      {[1, 2, 3].map((bar) => (
        <i key={bar} data-lit={bar <= level ? "" : undefined} />
      ))}
    </span>
  );
}

/** Renders one row of a place's contents: a card or an inner place, as a button that walks there. */
function WalkRow({
  title,
  status,
  end,
  onWalk,
  isInner,
}: {
  readonly title: string;
  readonly status?: EntityStatus | undefined;
  readonly end?: string | undefined;
  readonly onWalk: () => void;
  readonly isInner?: boolean | undefined;
}): JSX.Element {
  return (
    <button
      type="button"
      className={isInner === true ? "open-card-inner-go" : "open-card-card-go"}
      onClick={onWalk}
    >
      <span className="open-card-go-title">{title}</span>
      {status !== undefined && (
        <span className="open-card-go-status">
          <StatusShape shape={status.shape} tone={status.tone} size={13} />
          {status.label}
        </span>
      )}
      {end !== undefined && <span className="open-card-go-end">{end}</span>}
    </button>
  );
}

/** Renders the move rows of a card: Take it and Dismiss, or the one move to its Task, or why there are none. */
function OpenCardMoves({
  words,
  pluginName,
  userMonogram,
  onTake,
  onDismiss,
  onSeeTask,
}: {
  readonly words: OpenCardWords;
  readonly pluginName: string;
  readonly userMonogram: string;
  readonly onTake: () => void;
  readonly onDismiss: () => void;
  readonly onSeeTask: (taskId: string) => void;
}): JSX.Element {
  const { moves } = words;
  if (moves._tag === "task") {
    const { taskId } = moves;
    return (
      <div className="open-card-ledger">
        <button
          type="button"
          className="open-card-row"
          onClick={() => {
            onSeeTask(taskId);
          }}
        >
          <span className="open-card-label">See its Task</span>
          <span className="open-card-says">Goes to it on Work.</span>
          <kbd>G</kbd>
        </button>
      </div>
    );
  }
  const isOff = moves._tag === "off";
  return (
    <div className="open-card-ledger">
      {isOff && <p className="open-card-why">{moves.reason}</p>}
      <button type="button" className="open-card-row" disabled={isOff} onClick={onTake}>
        <span className="open-card-label">
          <span className="open-card-you" aria-hidden="true">
            {userMonogram}
          </span>
          Take it
        </span>
        <span className="open-card-says">You do it. No agent runs.</span>
        <kbd>T</kbd>
      </button>
      <button type="button" className="open-card-row is-quiet" disabled={isOff} onClick={onDismiss}>
        <span className="open-card-label">Dismiss</span>
        <span className="open-card-says">{`Takes it off your Inbox. ${pluginName} is not told.`}</span>
        <kbd>E</kbd>
      </button>
    </div>
  );
}

/**
 * Renders what the open sheet shows for a card: its mark and title, one line
 * of what it is, why it is here, its status, facts and wait, the line that
 * says its facts may be old, every place above it, and its moves.
 *
 * - `words` is `decideOpenCard`'s answer, and `url` is where the source shows the card.
 * - A card whose plugin is off keeps its words, its moves are off, and the
 *   sheet says why.
 * - `onWalk` is called with a place's ref when a row of "Part of" is chosen.
 *
 * - `timeline` is the timeline of signals, drawn between the facts and the
 *   places. A card with no timeline says why it is here in one line instead.
 * - `linked` is the section of the things linked to the card, drawn after
 *   the places, or `null` before the card's read has answered.
 */
export function OpenCardBody({
  url,
  words,
  plugins,
  userMonogram,
  onClose,
  onWalk,
  onTake,
  onDismiss,
  onSeeTask,
  timeline,
  linked,
}: {
  readonly url: string;
  readonly words: OpenCardWords;
  readonly plugins: readonly PluginIdentity[];
  readonly userMonogram: string;
  readonly timeline: ReactNode;
  readonly linked: ReactNode;
  readonly onClose: () => void;
  readonly onWalk: (ref: string) => void;
  readonly onTake: () => void;
  readonly onDismiss: () => void;
  readonly onSeeTask: (taskId: string) => void;
}): JSX.Element {
  const { face, wait, trust, places } = words;
  const pluginName = namePlugin(face.pluginId, plugins);
  return (
    <>
      <OpenCardHead
        pluginId={face.pluginId}
        plugins={plugins}
        title={face.title}
        meta={words.meta}
        onClose={onClose}
      />
      <div className="open-card-facts">
        {face.status !== undefined && <CardStatus status={face.status} size={15} />}
        {face.facts.map((fact, index) =>
          fact.form === "bars" ? (
            <PriorityBars key={index} level={fact.level} />
          ) : (
            <CardFactText key={index} fact={fact} />
          ),
        )}
        {wait !== null && <span className="open-card-wait">{wait.words}</span>}
        {url !== "" && (
          <a className="open-card-source" href={url} target="_blank" rel="noreferrer">
            {`Open in ${pluginName}`}
            <ExternalIcon size={13} />
          </a>
        )}
      </div>
      {trust !== undefined && <p className="open-card-trust">{trust}</p>}
      {timeline ??
        (words.reason !== undefined && (
          <p className="open-card-said" data-tone={words.reason.tone}>
            {words.reason.text}
          </p>
        ))}
      {places.length > 0 && (
        <OpenCardSection heading="Part of">
          <RelationRows rows={places} plugins={plugins} onWalk={onWalk} />
        </OpenCardSection>
      )}
      {linked}
      <OpenCardMoves
        words={words}
        pluginName={pluginName}
        userMonogram={userMonogram}
        onTake={onTake}
        onDismiss={onDismiss}
        onSeeTask={onSeeTask}
      />
    </>
  );
}

/** Returns the words a place row says about itself: its kind, its status and its target date. */
const describeInnerPlaceEnd = (row: PlaceRow): string | undefined => {
  if (row.isLocked) return undefined;
  return [
    row.progress?.words,
    row.targetDate === undefined ? undefined : formatTargetDate(row.targetDate),
  ]
    .filter((part) => part !== undefined)
    .join("  ");
};

/**
 * Renders what the open sheet shows for a place: what it says about itself,
 * how far along its source says it is, the cards of this page under it (and
 * under each place inside it), and every place above it. A place has no moves.
 *
 * - `view` is `readPlaceView`'s answer.
 * - `onWalkCard` is called with a card's id, and `onWalk` with a place's ref.
 */
export function OpenPlaceBody({
  view,
  plugins,
  onClose,
  onWalk,
  onWalkCard,
}: {
  readonly view: PlaceView;
  readonly plugins: readonly PluginIdentity[];
  readonly onClose: () => void;
  readonly onWalk: (ref: string) => void;
  readonly onWalkCard: (cardId: string) => void;
}): JSX.Element {
  const { row } = view;
  const pluginId = readEntityPluginId(row.kind);
  const pluginName = namePlugin(pluginId, plugins);
  if (row.isLocked) {
    return (
      <OpenCardHead
        pluginId={pluginId}
        plugins={plugins}
        title={describeLockedRow(row, pluginName)}
        meta={[row.noun]}
        onClose={onClose}
      />
    );
  }
  const hasCards = view.inner.length > 0 || view.cards.length > 0;
  return (
    <>
      <OpenCardHead
        pluginId={pluginId}
        plugins={plugins}
        title={row.title}
        meta={[row.caption ?? row.noun]}
        onClose={onClose}
      />
      {(row.status !== undefined || row.targetDate !== undefined) && (
        <div className="open-card-facts">
          {row.status !== undefined && <CardStatus status={row.status} size={15} />}
          {row.targetDate !== undefined && (
            <span className="open-card-wait">{`Target ${formatTargetDate(row.targetDate)}`}</span>
          )}
        </div>
      )}
      {row.progress !== undefined && (
        <p className="open-card-progress">
          <ProgressBar fraction={row.progress.fraction} wide />
          <span>
            {row.progress.words === undefined
              ? `As reported by ${pluginName}`
              : `${row.progress.words} done, as reported by ${pluginName}`}
          </span>
        </p>
      )}
      {hasCards && (
        <OpenCardSection heading="Yours here">
          <ul className="open-card-inner-list">
            {view.inner.map((inner) => (
              <li key={inner.row.ref} className="open-card-inner">
                <WalkRow
                  isInner
                  title={inner.row.isLocked ? inner.row.noun : inner.row.title}
                  status={inner.row.isLocked ? undefined : inner.row.status}
                  end={describeInnerPlaceEnd(inner.row)}
                  onWalk={() => {
                    onWalk(inner.row.ref);
                  }}
                />
                <ul>
                  {inner.cards.map((card) => (
                    <li key={card.id}>
                      <WalkRow
                        title={card.title}
                        status={card.status}
                        onWalk={() => {
                          onWalkCard(card.id);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {view.cards.map((card) => (
              <li key={card.id}>
                <WalkRow
                  title={card.title}
                  status={card.status}
                  onWalk={() => {
                    onWalkCard(card.id);
                  }}
                />
              </li>
            ))}
          </ul>
        </OpenCardSection>
      )}
      {view.above.length > 0 && (
        <OpenCardSection heading="Part of">
          <RelationRows rows={view.above} plugins={plugins} onWalk={onWalk} />
        </OpenCardSection>
      )}
    </>
  );
}
