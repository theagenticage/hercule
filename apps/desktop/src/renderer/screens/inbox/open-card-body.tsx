import { useEffect, useState, type JSX, type ReactNode } from "react";
import { namePlugin, type PluginIdentity } from "@hercule/client-core";
import type { OpenCardWords } from "@hercule/client-core/inbox";
import { CloseIcon } from "../../icons/close";
import { ExternalIcon } from "../../icons/external";
import { PluginMark } from "../../marks";
import { RelationRows } from "../desk";
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

/** How long the moves of a new sheet take no pointer, in milliseconds. */
const ARMING_MS = 420;

/**
 * Returns whether the moves of a sheet that has just opened still take no
 * pointer: true from the moment the sheet draws them until `ARMING_MS` later,
 * so that the second click of a double click, which lands on the move that
 * opened under the first, never starts anything. Keys are not held back.
 */
const useArming = (): boolean => {
  const [isArming, setIsArming] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsArming(false);
    }, ARMING_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return isArming;
};

/**
 * Renders the move rows of a card: `hand` (the Hand to rows, or nothing), then Start a thread (only when
 * `onStartThread` is given), Take on and Dismiss, or the move to its Task, or why there are none.
 * The rows carry `data-arming` and take no pointer while the sheet is new (`useArming`).
 */
function OpenCardMoves({
  words,
  hand,
  pluginName,
  userMonogram,
  onStartThread,
  onTake,
  onDismiss,
  onSeeTask,
}: {
  readonly words: OpenCardWords;
  readonly hand: ReactNode;
  readonly pluginName: string;
  readonly userMonogram: string;
  readonly onStartThread?: (() => void) | undefined;
  readonly onTake: () => void;
  readonly onDismiss: () => void;
  readonly onSeeTask: (taskId: string) => void;
}): JSX.Element {
  const { moves } = words;
  const isArming = useArming();
  if (moves._tag === "task") {
    const { taskId } = moves;
    return (
      <div className="open-card-ledger" data-arming={isArming ? "" : undefined}>
        {hand}
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
    <div className="open-card-ledger" data-arming={isArming ? "" : undefined}>
      {isOff && <p className="open-card-why">{moves.reason}</p>}
      {hand}
      {onStartThread === undefined ? null : (
        <button
          type="button"
          className="open-card-row is-quiet"
          disabled={isOff}
          onClick={onStartThread}
        >
          <span className="open-card-label">Start a thread</span>
          <span className="open-card-says">An agent starts on it, on a new Task.</span>
          <kbd>N</kbd>
        </button>
      )}
      <button type="button" className="open-card-row" disabled={isOff} onClick={onTake}>
        <span className="open-card-label">
          <span className="open-card-you" aria-hidden="true">
            {userMonogram}
          </span>
          Take on
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
 *   With none, the rows are plain rows: nothing opens from them.
 *
 * - `timeline` is the timeline of signals, drawn between the facts and the
 *   places. A card with no timeline says why it is here in one line instead.
 * - `linked` is the section of the things linked to the card, drawn after
 *   the places, or `null` before the card's read has answered.
 * - `hand` is the Hand to rows (`OpenCardHandRows`), drawn first among the
 *   moves, or `null` when the card cannot be handed to a workflow.
 */
export function OpenCardBody({
  sheetKey,
  url,
  words,
  plugins,
  userMonogram,
  onClose,
  onWalk,
  onStartThread,
  onTake,
  onDismiss,
  onSeeTask,
  timeline,
  linked,
  hand,
}: {
  /** Names the card the sheet shows. Another one starts the moves' arming again, as a new sheet does. */
  readonly sheetKey: string;
  readonly url: string;
  readonly words: OpenCardWords;
  readonly plugins: readonly PluginIdentity[];
  readonly userMonogram: string;
  readonly timeline: ReactNode;
  readonly linked: ReactNode;
  readonly hand: ReactNode;
  readonly onClose: () => void;
  readonly onWalk?: ((ref: string) => void) | undefined;
  /** Starts a thread on the card, on a new Task. With none, the sheet offers no Start a thread. */
  readonly onStartThread?: (() => void) | undefined;
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
        key={sheetKey}
        words={words}
        hand={hand}
        pluginName={pluginName}
        userMonogram={userMonogram}
        onStartThread={onStartThread}
        onTake={onTake}
        onDismiss={onDismiss}
        onSeeTask={onSeeTask}
      />
    </>
  );
}
