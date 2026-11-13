import type { JSX, Ref } from "react";
import {
  describeHandOff,
  describeHandOffLabel,
  type InboxRowHandOff,
} from "@hercule/client-core/inbox";
import { buildLook, Face } from "../../faces";
import { ArchiveIcon } from "../../icons/archive";
import { TasksIcon } from "../../icons/tasks";
import "./inbox-pane-footer.css";

/** How many faces the hand-off button shows when several workflows fit. */
const HAND_OFF_FACES = 3;

/**
 * Renders the button that dismisses at the end of the pane's footer: an icon
 * with `words` as its name ("Dismiss", "Dismiss all 3") and the key E in its
 * tooltip. It calls `onDismiss` when pressed.
 */
export function InboxPaneDismiss({
  words,
  onDismiss,
}: {
  readonly words: string;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
    <span className="ib-pane-foot-end">
      <button
        type="button"
        className="icon-btn ib-pane-dismiss"
        title={`${words} (E)`}
        aria-label={words}
        aria-keyshortcuts="E"
        onClick={onDismiss}
      >
        <ArchiveIcon size={16} />
      </button>
    </span>
  );
}

/**
 * Renders the footer of the pane of one thing: the moves that work, Take on
 * (T), the hand-off (H), and Dismiss (E) as an icon at the end. No move is
 * filled.
 *
 * - Take on is left out when `isTakenOn` is true: the user already holds the
 *   thing.
 * - `handOff` is the hand-off button, or `null` when no workflow takes the
 *   thing. With one workflow it shows that workflow's face and its whole name,
 *   and its accessible name is "Hand to <name>". With several it shows the
 *   first three faces and "Hand to…", and opens a menu: `isHandMenuOpen` is
 *   that menu's `aria-expanded`. `handAnchorRef` receives the button, where
 *   the menu anchors.
 * - The pane's width, through a container query, changes the layout. Under
 *   460px the hand-off comes first and Take on is an icon. Under 400px the
 *   key hints leave the buttons and stay in the tooltips.
 */
export function InboxPaneFooter({
  isTakenOn,
  handOff,
  isHandMenuOpen,
  handAnchorRef,
  onTakeOn,
  onHandOff,
  onDismiss,
}: {
  readonly isTakenOn: boolean;
  readonly handOff: InboxRowHandOff | null;
  readonly isHandMenuOpen: boolean;
  readonly handAnchorRef?: Ref<HTMLButtonElement>;
  readonly onTakeOn: () => void;
  readonly onHandOff: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const handName = handOff === null ? "" : describeHandOff(handOff);
  return (
    <footer className="ib-pane-foot-box">
      <div className="ib-pane-foot">
        {!isTakenOn && (
          <button
            type="button"
            className="btn btn--sm ib-pane-move has-icon"
            title="Take on (T)"
            aria-label="Take on"
            aria-keyshortcuts="T"
            onClick={onTakeOn}
          >
            <span className="ib-pane-move-icon">
              <TasksIcon size={14} />
            </span>
            <span className="ib-pane-move-label">Take on</span>
            <kbd aria-hidden="true">T</kbd>
          </button>
        )}
        {handOff !== null && (
          <button
            type="button"
            className="btn btn--sm ib-pane-move ib-pane-move--hand"
            ref={handAnchorRef}
            data-hand-anchor=""
            title={`${handName} (H)`}
            aria-label={handName}
            aria-keyshortcuts="H"
            {...(handOff.kind === "several"
              ? { "aria-haspopup": "menu" as const, "aria-expanded": isHandMenuOpen }
              : {})}
            onClick={onHandOff}
          >
            <span className="ib-pane-move-label">
              <span className="ib-pane-faces" aria-hidden="true">
                {(handOff.kind === "one"
                  ? [handOff.faceSeed]
                  : handOff.faceSeeds.slice(0, HAND_OFF_FACES)
                ).map((seed) => (
                  <Face key={seed} look={buildLook(seed)} pose="idle" size={18} />
                ))}
              </span>
              <span className="ib-pane-move-name">{describeHandOffLabel(handOff)}</span>
            </span>
            <kbd aria-hidden="true">H</kbd>
          </button>
        )}
        <InboxPaneDismiss words="Dismiss" onDismiss={onDismiss} />
      </div>
    </footer>
  );
}
