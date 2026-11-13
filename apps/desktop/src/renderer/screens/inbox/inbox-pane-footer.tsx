import type { JSX, ReactNode } from "react";
import type { InboxRowHandOff } from "@hercule/client-core/inbox";
import { buildLook, Face } from "../../faces";
import { ArchiveIcon } from "../../icons/archive";
import { LinkIcon } from "../../icons/link";
import { TasksIcon } from "../../icons/tasks";
import "./inbox-pane-footer.css";

/** How many faces the hand-off button shows when several workflows fit. */
const HAND_OFF_FACES = 3;

/**
 * Renders the end of the pane's footer: the icon buttons, pushed to the right
 * edge. `children` are those buttons, in order.
 */
export function InboxPaneFootEnd({ children }: { readonly children: ReactNode }): JSX.Element {
  return <span className="ib-pane-foot-end">{children}</span>;
}

/**
 * Renders the button that dismisses at the end of the pane's footer: an icon
 * with `words` as its name ("Dismiss", "Dismiss all 3") and the key E in its
 * tooltip. It calls `onDismiss` when pressed. It sits in its own end of the
 * footer; to put it beside other icon buttons, use `InboxPaneDismissButton`
 * inside an `InboxPaneFootEnd`.
 */
export function InboxPaneDismiss({
  words,
  onDismiss,
}: {
  readonly words: string;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
    <InboxPaneFootEnd>
      <InboxPaneDismissButton words={words} onDismiss={onDismiss} />
    </InboxPaneFootEnd>
  );
}

/** Renders the icon button of Dismiss alone: `words` is its name and `onDismiss` is called when it is pressed. */
export function InboxPaneDismissButton({
  words,
  onDismiss,
}: {
  readonly words: string;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
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
  );
}

/**
 * Renders the icon button of Link (L): `words` is its name, such as "Link another thing", and
 * `onLink` is called when it is pressed.
 */
export function InboxPaneLinkButton({
  words,
  onLink,
}: {
  readonly words: string;
  readonly onLink: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn ib-pane-dismiss"
      title={`${words} (L)`}
      aria-label={words}
      aria-keyshortcuts="L"
      onClick={onLink}
    >
      <LinkIcon size={16} />
    </button>
  );
}

/**
 * Renders Link (L) as a move of the footer's start, beside Take on, for the pane of a selection: the
 * things it holds are linked to each other. It is an icon under 460px, like Take on. `words` is its
 * accessible name, such as "Link all 3", and `onLink` is called when it is pressed.
 */
export function InboxPaneLinkMove({
  words,
  onLink,
}: {
  readonly words: string;
  readonly onLink: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="btn btn--sm ib-pane-move has-icon"
      title={`${words} (L)`}
      aria-label={words}
      aria-keyshortcuts="L"
      onClick={onLink}
    >
      <span className="ib-pane-move-icon">
        <LinkIcon size={14} />
      </span>
      <span className="ib-pane-move-label">Link</span>
      <kbd aria-hidden="true">L</kbd>
    </button>
  );
}

/**
 * Renders the Take on button (T) of the footer. It is an icon under 460px,
 * through the footer's container query. It calls `onTakeOn` when pressed.
 */
export function InboxPaneTakeOnButton({
  onTakeOn,
}: {
  readonly onTakeOn: () => void;
}): JSX.Element {
  return (
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
  );
}

/**
 * Renders the footer of the pane of one thing: the moves that work, Take on
 * (T), the hand-off (H), and Link (L) and Dismiss (E) as icons at the end. No
 * move is filled.
 *
 * - Take on is left out when `isTakenOn` is true: the user already holds the
 *   thing.
 * - `handOff` is the hand-off button, or `null` when no workflow takes the
 *   thing. With one workflow it shows that workflow's face and its whole name,
 *   and its accessible name is "Hand to <name>". With several it shows the
 *   first three faces and "Hand to…", and opens a menu: `isHandMenuOpen` is
 *   that menu's `aria-expanded`. The button carries `data-hand-anchor`, where
 *   the menu anchors.
 * - The pane's width, through a container query, changes the layout. Under
 *   460px the hand-off comes first and Take on is an icon. Under 400px the
 *   key hints leave the buttons and stay in the tooltips.
 */
export function InboxPaneFooter({
  isTakenOn,
  handOff,
  isHandMenuOpen,
  onTakeOn,
  onHandOff,
  onLink,
  onDismiss,
}: {
  readonly isTakenOn: boolean;
  readonly handOff: InboxRowHandOff | null;
  readonly isHandMenuOpen: boolean;
  readonly onTakeOn: () => void;
  readonly onHandOff: () => void;
  readonly onLink: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const handName =
    handOff === null ? "" : handOff.kind === "one" ? `Hand to ${handOff.name}` : "Hand to…";
  return (
    <footer className="ib-pane-foot-box">
      <div className="ib-pane-foot">
        {!isTakenOn && <InboxPaneTakeOnButton onTakeOn={onTakeOn} />}
        {handOff !== null && (
          <button
            type="button"
            className="btn btn--sm ib-pane-move ib-pane-move--hand"
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
              <span className="ib-pane-move-name">
                {handOff.kind === "one" ? handOff.name : "Hand to…"}
              </span>
            </span>
            <kbd aria-hidden="true">H</kbd>
          </button>
        )}
        <InboxPaneFootEnd>
          <InboxPaneLinkButton words="Link to another thing" onLink={onLink} />
          <InboxPaneDismissButton words="Dismiss" onDismiss={onDismiss} />
        </InboxPaneFootEnd>
      </div>
    </footer>
  );
}
