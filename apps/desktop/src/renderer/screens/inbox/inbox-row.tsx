import type { PluginIdentity } from "@hercule/client-core";
import type {
  InboxRowHolder,
  InboxRowReason,
  InboxRowTime,
  InboxRowView,
} from "@hercule/client-core/inbox";
import type { JSX, MouseEvent } from "react";
import { buildLook, Face, UserAvatar } from "../../faces";
import { ArchiveIcon } from "../../icons/archive";
import { ArrowIcon } from "../../icons/arrow";
import { CheckIcon } from "../../icons/check";
import { TasksIcon } from "../../icons/tasks";
import { PluginMark } from "../../marks";
import { EntityStatusIcon } from "../desk/status-shape";
import "./inbox-list.css";

/** Which modifier keys were down on a click. The caller decides what they mean on this platform. */
export interface InboxClickModifiers {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** What a row calls back with, every one given the row's reference. */
export interface InboxRowActions {
  /** The row was clicked: it becomes current, or the selection changes by `modifiers`. */
  readonly onPick: (ref: string, modifiers: InboxClickModifiers) => void;
  /** The row's tick was pressed. */
  readonly onToggleSelect: (ref: string) => void;
  readonly onTakeOn: (ref: string) => void;
  readonly onHandOff: (ref: string) => void;
  readonly onGoToTask: (ref: string) => void;
  readonly onDismiss: (ref: string) => void;
}

/** The size of a mark and of a status shape in the row's left column. */
const LEAD_SIZE = 16;

/** Renders whoever holds the thing, 18px, in the place of the wait. */
function HolderFigure({ holder }: { readonly holder: InboxRowHolder }): JSX.Element {
  return (
    <span className="ib-row-time ib-row-time--held" title={holder.words}>
      {holder.kind === "you" ? (
        <UserAvatar name={holder.name} size={18} />
      ) : (
        <Face look={buildLook(holder.faceSeed)} pose="idle" size={18} />
      )}
    </span>
  );
}

/** Renders the first line's right end: the wait, the holder, or an empty slot that keeps the title's width. */
function TimeFigure({ time }: { readonly time: InboxRowTime }): JSX.Element {
  if (time.kind === "holder") return <HolderFigure holder={time.holder} />;
  if (time.kind === "none") return <span className="ib-row-time" aria-hidden="true" />;
  return (
    <span className={`ib-row-time ib-wait--${time.tone}`} title={time.words}>
      {time.text}
    </span>
  );
}

/** Renders the second line's sentence: the person in ink, the rest muted, the "+n" chip and the aside. */
function ReasonLine({ reason }: { readonly reason: InboxRowReason }): JSX.Element {
  return (
    <span className="ib-row-why">
      {reason.who === undefined ? null : <b className="ib-who">{reason.who} </b>}
      {reason.rest}
      {reason.more > 0 ? (
        <span className="ib-more" title={`${String(reason.more)} more on it`}>
          +{reason.more}
        </span>
      ) : null}
      {reason.aside === undefined ? null : <span className="ib-aside"> · {reason.aside}</span>}
    </span>
  );
}

/** Renders the moves under the pointer, each with its key in its tooltip. */
function RowMoves({
  view,
  actions,
}: {
  readonly view: InboxRowView;
  readonly actions: InboxRowActions;
}): JSX.Element {
  const { ref, handOff } = view;
  return (
    <span className="ib-row-acts">
      {view.held ? (
        <button
          type="button"
          className="ib-row-act"
          tabIndex={-1}
          title="Go to its Task (G)"
          aria-label="Go to its Task"
          aria-keyshortcuts="G"
          onClick={() => {
            actions.onGoToTask(ref);
          }}
        >
          <ArrowIcon size={14} />
        </button>
      ) : (
        <>
          <button
            type="button"
            className="ib-row-act"
            tabIndex={-1}
            title="Take on (T)"
            aria-label="Take on"
            aria-keyshortcuts="T"
            onClick={() => {
              actions.onTakeOn(ref);
            }}
          >
            <TasksIcon size={14} />
          </button>
          {handOff === null ? null : (
            <button
              type="button"
              className="ib-row-act ib-row-act--named"
              tabIndex={-1}
              title={handOff.kind === "one" ? `Hand to ${handOff.name} (H)` : "Hand to… (H)"}
              aria-label={handOff.kind === "one" ? `Hand to ${handOff.name}` : "Hand to…"}
              aria-keyshortcuts="H"
              onClick={() => {
                actions.onHandOff(ref);
              }}
            >
              <span className="ib-row-faces" aria-hidden="true">
                {(handOff.kind === "one" ? [handOff.faceSeed] : handOff.faceSeeds.slice(0, 3)).map(
                  (seed) => (
                    <Face key={seed} look={buildLook(seed)} pose="idle" size={16} />
                  ),
                )}
              </span>
              <span>{handOff.kind === "one" ? handOff.name : "Hand to…"}</span>
            </button>
          )}
        </>
      )}
      <button
        type="button"
        className="ib-row-act"
        tabIndex={-1}
        title="Dismiss (E)"
        aria-label="Dismiss"
        aria-keyshortcuts="E"
        onClick={() => {
          actions.onDismiss(ref);
        }}
      >
        <ArchiveIcon size={14} />
      </button>
    </span>
  );
}

/**
 * Renders one thing as a row of the Inbox list, 52px and two lines:
 *
 * - the left column holds the plugin's mark over the status shape; over the
 *   mark, a tick takes its place, and a selected row keeps the tick filled;
 * - the first line holds the title (cut at the end) and the time;
 * - the second line holds the sentence and where the thing lives (the place
 *   is cut first, the identifier never shrinks).
 *
 * Under the pointer, the row's own moves appear at its right end. The row
 * decides and computes nothing: `view` holds the words, and `actions` is
 * called with the row's reference. With `actions` null the row is an inert
 * copy, such as one that fades out of the list: it has no buttons and no tick.
 *
 * The row is a tree item at level 1. `position` is its place among `size`
 * rows, one based, because a virtual list draws only some of them. Only the
 * current row is in the tab order.
 */
export function InboxRow({
  view,
  plugins,
  position,
  size,
  current,
  selected,
  actions,
}: {
  readonly view: InboxRowView;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly position: number;
  readonly size: number;
  readonly current: boolean;
  readonly selected: boolean;
  readonly actions: InboxRowActions | null;
}): JSX.Element {
  const { reason, place, identifier } = view;
  const pick = (event: MouseEvent<HTMLDivElement>): void => {
    if (actions === null) return;
    // A press on one of the row's own buttons is that button's.
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    actions.onPick(view.ref, {
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    });
  };
  const classes = ["ib-row"];
  if (current) classes.push("is-current");
  if (selected) classes.push("is-picked");
  if (reason.quiet) classes.push("is-quiet");
  return (
    // The list owns the keyboard (J, K and the other keys of the screen). A click is the pointer's way to the same row.
    <div
      className={classes.join(" ")}
      role="treeitem"
      aria-level={1}
      aria-posinset={position}
      aria-setsize={size}
      aria-selected={selected}
      aria-label={view.label}
      tabIndex={current ? 0 : -1}
      data-ref={view.ref}
      onClick={pick}
    >
      <span className="ib-row-lead">
        <span className="ib-mark">
          <PluginMark pluginId={view.pluginId} plugins={plugins} size={LEAD_SIZE} />
        </span>
        {actions === null ? null : (
          <button
            type="button"
            className={selected ? "ib-row-tick is-on" : "ib-row-tick"}
            tabIndex={-1}
            aria-label={selected ? "Unselect" : "Select"}
            aria-keyshortcuts="X"
            onClick={() => {
              actions.onToggleSelect(view.ref);
            }}
          >
            <CheckIcon size={12} />
          </button>
        )}
      </span>
      <span className="ib-row-l1">
        <span className="ib-row-title">{view.title}</span>
        <TimeFigure time={view.time} />
      </span>
      <span className="ib-row-glyph">
        {view.status === undefined ? null : (
          <span title={view.status.label}>
            <EntityStatusIcon status={view.status} size={14} />
          </span>
        )}
      </span>
      <span className="ib-row-l2">
        <ReasonLine reason={reason} />
        {place === undefined && identifier === undefined ? null : (
          <span className="ib-row-where">
            {place === undefined ? null : <span className="ib-row-place">{place}</span>}
            {identifier === undefined ? null : <span className="ib-row-id">{identifier}</span>}
          </span>
        )}
      </span>
      {actions === null ? null : <RowMoves view={view} actions={actions} />}
    </div>
  );
}
