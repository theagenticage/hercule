import { useRef, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildInitials,
  readErrorMessage,
  type HerculeClient,
  type PluginIdentity,
} from "@hercule/client-core";
import {
  decideOpenCard,
  isCardTimeDependent,
  readPlaceView,
  type PlaceView,
} from "@hercule/client-core/inbox";
import type { Inbox } from "@hercule/contract";
import { entityQuery, userQuery } from "../../app/queries";
import { ArrowIcon } from "../../icons/arrow";
import { OpeningSheet, type SheetPlaces, type SheetRect } from "../desk";
import { OpenCardBody, OpenPlaceBody } from "./open-card-body";
import { readOpenCardPlaces } from "./open-card-places";
import type { OpenCard, OpenTarget } from "./use-open-card";
import { useMinuteClock } from "./use-minute-clock";

/** What the open card needs of the page: the moves it offers. Each is called with the card's id. */
export interface OpenCardMoveHandlers {
  /** Takes the card on. The page folds the sheet and plays the move on the card. */
  readonly onTake: (cardId: string) => void;
  /** Dismisses the card. The page folds the sheet and plays the move on the card. */
  readonly onDismiss: (cardId: string) => void;
  /** Goes to the card's Task on Work. Called with the Task's id. */
  readonly onSeeTask: (taskId: string) => void;
}

/** Returns the name of the card or place `target`, for the dialog's name and for the way back. */
const nameTarget = (target: OpenTarget, inbox: Inbox | undefined): string => {
  if (target.kind === "card") {
    return inbox?.cards.find((each) => each.id === target.id)?.title ?? "Back";
  }
  return inbox?.places.find((each) => each.ref === target.ref)?.title ?? "Back";
};

/** Returns the key that tells one thing the sheet shows from another, such that a card and a place never share one. */
const keyTarget = (target: OpenTarget): string =>
  target.kind === "card" ? `card:${target.id}` : `place:${target.ref}`;

/**
 * Renders the body of the open sheet for the card `id`. It draws at once from
 * the Inbox's own record of the card, then from `externalEntity.read` when
 * that answers, which also says whether the card's plugin is still active.
 * Orchestrating: it owns this read.
 */
function OpenCardContents({
  id,
  inbox,
  client,
  plugins,
  userInitial,
  onClose,
  onWalk,
  moves,
}: {
  readonly id: string;
  readonly inbox: Inbox | undefined;
  readonly client: HerculeClient;
  readonly plugins: readonly PluginIdentity[];
  readonly userInitial: string;
  readonly onClose: () => void;
  readonly onWalk: (ref: string) => void;
  readonly moves: OpenCardMoveHandlers;
}): JSX.Element {
  const detail = useQuery(entityQuery(client, id));
  const record = detail.data ?? inbox?.cards.find((card) => card.id === id);
  const now = useMinuteClock(record !== undefined && isCardTimeDependent(record));
  if (record === undefined) {
    return (
      <p className="open-card-trust">
        {detail.isError
          ? `This card could not be read. ${readErrorMessage(detail.error)}`
          : "Reading…"}
      </p>
    );
  }
  const words = decideOpenCard(
    record,
    detail.data ?? inbox ?? { places: [], edges: [] },
    detail.data?.kindAvailable ?? true,
    now,
  );
  return (
    <OpenCardBody
      url={record.url}
      words={words}
      plugins={plugins}
      userInitial={userInitial}
      onClose={onClose}
      onWalk={onWalk}
      onTake={() => {
        moves.onTake(id);
      }}
      onDismiss={() => {
        moves.onDismiss(id);
      }}
      onSeeTask={moves.onSeeTask}
    />
  );
}

/**
 * Renders the open card of the Inbox: the sheet a card opens into, where it
 * lies, over a flat veil. It shows the card with everything it says: its
 * status, its facts and wait, why it may be out of date, every place above
 * it, and its moves. A place, from a place's head or a row of "Part of",
 * shows the bigger picture: what it says about itself, how far along its
 * source says it is, and the cards of this page under it. A line at the top
 * goes back to what the sheet showed before.
 *
 * - `openCard` is what `useOpenCard` returns. The page drives it: this
 *   component draws it and walks inside it.
 * - `inbox` is the page's read, which a place is drawn from (no new read).
 * - `moves` are the page's moves. A move on a card calls them, and the page
 *   folds the sheet and plays the move when it has landed
 *   (`openCard.closeThen`).
 * - A card whose plugin is off keeps its words, its moves are off, and the
 *   sheet says why. A place has no moves.
 *
 * The page renders it once, in the desk's `overlays`. It draws nothing while
 * nothing is open.
 */
export function InboxOpenCard({
  openCard,
  client,
  inbox,
  plugins,
  onTake,
  onDismiss,
  onSeeTask,
}: {
  readonly openCard: OpenCard;
  readonly client: HerculeClient;
  readonly inbox: Inbox | undefined;
  readonly plugins: readonly PluginIdentity[];
} & OpenCardMoveHandlers): JSX.Element | null {
  const { sheet } = openCard;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const contentRef = useRef<HTMLDivElement>(null);
  const heldDestinationRef = useRef<SheetRect | null>(null);
  const { shown } = sheet;
  if (shown === null) return null;

  const readPlaces = (): SheetPlaces => {
    const places = readOpenCardPlaces(
      sheet.originElement,
      contentRef.current!,
      heldDestinationRef.current,
    );
    heldDestinationRef.current = places.destination;
    return places;
  };
  const placeView: PlaceView | undefined =
    shown.kind === "place" && inbox !== undefined ? readPlaceView(shown.ref, inbox) : undefined;
  const back = sheet.trail.at(-1);
  const walkToPlace = (ref: string): void => {
    sheet.walkInside({ kind: "place", ref });
  };
  const walkToCard = (id: string): void => {
    sheet.walkInside({ kind: "card", id });
  };
  const userInitial = buildInitials(username);
  return (
    <OpeningSheet
      isOpen={sheet.isOpen}
      contentKey={keyTarget(shown)}
      label={nameTarget(shown, inbox)}
      readPlaces={readPlaces}
      onClosed={() => {
        const origin = sheet.originElement;
        heldDestinationRef.current = null;
        // Focus goes home first: the move the sheet was closed for runs in `finishClose`, and may take the card away.
        origin?.focus({ preventScroll: true });
        sheet.finishClose();
      }}
      behind={
        <div
          className="open-card-veil"
          data-on={sheet.isOpen ? "" : undefined}
          onClick={openCard.close}
        />
      }
    >
      <div ref={contentRef} className="open-card">
        {back !== undefined && (
          <button type="button" className="open-card-back" onClick={sheet.walkBack}>
            <ArrowIcon size={12} />
            <span>{nameTarget(back, inbox)}</span>
          </button>
        )}
        {shown.kind === "card" ? (
          <OpenCardContents
            key={shown.id}
            id={shown.id}
            inbox={inbox}
            client={client}
            plugins={plugins}
            userInitial={userInitial}
            onClose={openCard.close}
            onWalk={walkToPlace}
            moves={{ onTake, onDismiss, onSeeTask }}
          />
        ) : placeView === undefined ? (
          <p className="open-card-trust">This place is not on the Inbox now.</p>
        ) : (
          <OpenPlaceBody
            view={placeView}
            plugins={plugins}
            onClose={openCard.close}
            onWalk={walkToPlace}
            onWalkCard={walkToCard}
          />
        )}
      </div>
    </OpeningSheet>
  );
}
