import { Fragment, type JSX, type Ref } from "react";
import { Face, HERCULE_LOOK } from "../../faces";
import { AlertIcon } from "../../icons/alert";
import "./inbox-states.css";

/**
 * The widths, in percent of the row, of the title line in each of the
 * skeleton's 14 rows. Rows differ so the list reads as text, not as a table.
 */
const SKELETON_TITLE_WIDTHS: readonly number[] = [
  72, 58, 80, 64, 50, 76, 61, 69, 55, 73, 66, 59, 70, 52,
];
/** How much shorter than the title line the second line of a skeleton row is, in percent. */
const SKELETON_SECOND_LINE_SHORTER = 18;

/**
 * Renders the Inbox list while its first page is being read: the shapes of 14
 * rows, drawn still. Nothing pulses, so a slow read costs no frames. The
 * rows are hidden from assistive technology; the list that holds them says it
 * is busy (`aria-busy`), which is the orchestrator's to set.
 */
export function InboxRowsSkeleton(): JSX.Element {
  return (
    <>
      {SKELETON_TITLE_WIDTHS.map((width) => (
        <div key={width} className="ib-skel" aria-hidden="true">
          <i />
          <i style={{ width: `${String(width)}%` }} />
          <i />
          <i />
          <i style={{ width: `${String(width - SKELETON_SECOND_LINE_SHORTER)}%` }} />
        </div>
      ))}
    </>
  );
}

/**
 * Renders a count that is still being read, as a small still bar, for the
 * rail's rows and the list head. Hidden from assistive technology.
 */
export function InboxCountSkeleton(): JSX.Element {
  return <span className="ib-skel-n" aria-hidden="true" />;
}

/**
 * Renders the pane while the thing it shows is being read: the shapes of a
 * small title, two lines of heading and two blocks, drawn still. Hidden from
 * assistive technology.
 */
export function InboxPaneSkeleton(): JSX.Element {
  return (
    <div className="ib-pane-skel" aria-hidden="true">
      <i style={{ width: "46%" }} />
      <i style={{ width: "88%", height: 16, marginTop: 10 }} />
      <i style={{ width: "60%", height: 16 }} />
      <i style={{ width: "38%" }} />
      <i style={{ width: "100%", height: 96, marginTop: 16, borderRadius: 12 }} />
      <i style={{ width: "100%", height: 44, marginTop: 8, borderRadius: 12 }} />
    </div>
  );
}

/**
 * Renders the pill in the Inbox's bar while the controller cannot be
 * reached: "Offline · 09:12", and the whole sentence in its tooltip. Nothing
 * waits in an outbox: a move made offline is refused, and the undo line says
 * so, so the pill does not count anything.
 *
 * `sinceLabel` is the time the connection was lost, already written for the
 * reader, such as "09:12".
 */
export function InboxOfflinePill({ sinceLabel }: { readonly sinceLabel: string }): JSX.Element {
  return (
    <span
      className="ib-offline"
      role="status"
      title={`Offline since ${sinceLabel}. The list shows what it held then. Moves are refused until the connection is back.`}
    >
      Offline · {sinceLabel}
    </span>
  );
}

/**
 * Renders the line over the list that names a source Hercule cannot read
 * (`sourceName`, "GitHub") and since when (`sinceLabel`, "08:40"), with a
 * link that calls `onOpenConnections`, where the source's Connection is.
 */
export function InboxFailingSource({
  sourceName,
  sinceLabel,
  onOpenConnections,
}: {
  readonly sourceName: string;
  readonly sinceLabel: string;
  readonly onOpenConnections: () => void;
}): JSX.Element {
  return (
    <div className="ib-failing" role="status">
      <AlertIcon size={14} />
      <span>
        <b>{sourceName}</b> can’t be read since {sinceLabel}. Its things show what it said then.
      </span>
      <button type="button" className="ib-failing-link" onClick={onOpenConnections}>
        Connections
      </button>
    </div>
  );
}

/** One ray of the sunrise: where it ends, and how many rays from the middle one it is. */
const SUNRISE_RAYS = Array.from({ length: 9 }, (_, index) => {
  const angle = ((-80 + index * 20) * Math.PI) / 180;
  return {
    index,
    x: 60 + Math.sin(angle) * 54,
    y: 58 - Math.cos(angle) * 54,
    fromMiddle: Math.abs(index - 4),
  };
});

/**
 * The sunrise, drawn from the drawing's own geometry: nine dashed rays fan
 * from a point on the horizon, and Hercule's head comes up over it. It is one
 * drawing at two sizes.
 *
 * It is not the `Sunrise` of `screens/desk/sunrise.tsx`, on purpose. That one
 * fans 31 solid rays out of a ring around the head, with a gap before the
 * face, and sizes the face from the width. This one has 9 dashed rays that
 * start at the horizon's middle, a fixed 168 by 90 box and a 40px head.
 * Those are two different pictures, and the signed-off drawing asks for this
 * one in the Inbox. Everything is `aria-hidden`; the words beside it say
 * what it means.
 */
function Sunrise(): JSX.Element {
  return (
    <>
      <svg className="ib-sun" viewBox="0 0 120 64" width="168" height="90" aria-hidden="true">
        <g className="ib-sun-rays">
          {SUNRISE_RAYS.map((ray) => (
            <line
              key={ray.index}
              x1="60"
              y1="58"
              x2={ray.x.toFixed(1)}
              y2={ray.y.toFixed(1)}
              style={{ "--ray": ray.fromMiddle }}
            />
          ))}
        </g>
        <line className="ib-sun-line" x1="6" y1="58" x2="114" y2="58" />
      </svg>
      <span className="ib-sun-head" aria-hidden="true">
        <Face look={HERCULE_LOOK} pose="idle" size={40} />
      </span>
    </>
  );
}

/** What the Inbox has nothing to show for. */
export type InboxEmptyState =
  | { readonly kind: "all-clear" }
  | {
      /** The waits list is empty: `updatesCount` things changed without asking. */
      readonly kind: "nobody-waits";
      readonly updatesCount: number;
      readonly onOpenUpdates: () => void;
    }
  | {
      /** A saved query other than the waits list holds nothing. `title` is its name. */
      readonly kind: "nothing-in-list";
      readonly title: string;
    }
  | {
      /**
       * The search found nothing in the list named `scopeTitle`. `tokens` are
       * the typed fields as written ("team:payments"), `text` the free text.
       * `widerCount` is what the same search finds in Everything; the button
       * for it shows only when it is above 0.
       */
      readonly kind: "nothing-matches";
      readonly scopeTitle: string;
      readonly tokens: readonly string[];
      readonly text: string;
      readonly widerCount: number;
      readonly onSearchEverything: () => void;
      readonly onClearSearch: () => void;
    };

/** Returns the words that say what the search looked for, such as "`team:payments` and “checkout”". */
function SearchedFor({
  tokens,
  text,
}: {
  readonly tokens: readonly string[];
  readonly text: string;
}): JSX.Element {
  const parts = tokens.map((token) => ({ key: token, words: <code>{token}</code> }));
  if (text !== "") parts.push({ key: `text:${text}`, words: <>“{text}”</> });
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && " and "}
          {part.words}
        </Fragment>
      ))}
    </>
  );
}

/** Returns the line under the heading of a saved query that has nothing. */
function EmptyLine({ state }: { readonly state: InboxEmptyState }): JSX.Element {
  switch (state.kind) {
    case "all-clear":
      return <>Nothing out there needs you. New things arrive here as your sources see them.</>;
    case "nobody-waits":
      return (
        <>
          {state.updatesCount === 0
            ? "Nothing changed without asking anything. It would be in "
            : `${String(state.updatesCount)} ${state.updatesCount === 1 ? "thing" : "things"} changed without asking anything. They are in `}
          <button type="button" className="ib-em-link" onClick={state.onOpenUpdates}>
            Updates
          </button>
          .
        </>
      );
    case "nothing-in-list":
      return <>Nothing of yours here yet.</>;
    case "nothing-matches":
      return (
        <>
          No thing here has <SearchedFor tokens={state.tokens} text={state.text} />.
        </>
      );
  }
}

/** Returns the heading of an empty state. */
function emptyHeading(state: InboxEmptyState): string {
  switch (state.kind) {
    case "all-clear":
      return "All clear";
    case "nobody-waits":
      return "Nobody waits on you";
    case "nothing-in-list":
      return `Nothing in ${state.title}`;
    case "nothing-matches":
      return `Nothing in ${state.scopeTitle} matches`;
  }
}

/**
 * Renders what the list shows when it holds nothing, by `state`:
 *
 * - `all-clear`: nothing anywhere. The full sunrise.
 * - `nobody-waits` and `nothing-in-list`: the small sunrise.
 * - `nothing-matches`: no sunrise, the search and two buttons.
 *
 * A sunrise draws once, when it mounts, and waits 240ms first for the last
 * row and the pane to leave. The component keeps the same elements when
 * `state` changes between the two sunrise kinds, so it does not draw again.
 * Reduced motion shows it at rest.
 *
 * The heading takes the focus without drawing a ring, for a screen reader to
 * start there: pass `headingRef` and call `focus()` on it. The orchestrator
 * does that when a move leaves nothing current, not when the Inbox opens
 * empty. The heading stays the same element while its words change, so the
 * focus stays on it.
 */
export function InboxEmpty({
  state,
  headingRef,
}: {
  readonly state: InboxEmptyState;
  readonly headingRef?: Ref<HTMLHeadingElement>;
}): JSX.Element {
  const hasSunrise = state.kind !== "nothing-matches";
  return (
    <div className="ib-empty">
      <div
        className={state.kind === "all-clear" ? "ib-em ib-em--zero" : "ib-em"}
        style={hasSunrise ? { "--sun-wait": "240ms" } : undefined}
      >
        {hasSunrise && (
          <div className={state.kind === "all-clear" ? "ib-em-sun" : "ib-em-sun ib-em-sun--small"}>
            <Sunrise />
          </div>
        )}
        <h2 ref={headingRef} className="ib-em-title" tabIndex={-1}>
          {emptyHeading(state)}
        </h2>
        <p className="ib-em-line">
          <EmptyLine state={state} />
        </p>
        {state.kind === "nothing-matches" && (
          <>
            {state.widerCount > 0 && (
              <button type="button" className="btn btn--sm" onClick={state.onSearchEverything}>
                Search Everything · {state.widerCount}
                <kbd>⌫</kbd>
              </button>
            )}
            <button type="button" className="btn btn--sm btn--quiet" onClick={state.onClearSearch}>
              Clear the search
              <kbd>Esc</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Renders what the list shows when its first page could not be read: "The
 * Inbox could not be read", the controller's `reason`, and a Try again button
 * that calls `onTryAgain`.
 */
export function InboxReadFailed({
  reason,
  onTryAgain,
}: {
  readonly reason: string;
  readonly onTryAgain: () => void;
}): JSX.Element {
  return (
    <div className="ib-empty" role="alert">
      <div className="ib-em">
        <h2 className="ib-em-title">The Inbox could not be read</h2>
        <p className="ib-em-line">{reason}</p>
        <button type="button" className="btn btn--sm" onClick={onTryAgain}>
          Try again
        </button>
      </div>
    </div>
  );
}
