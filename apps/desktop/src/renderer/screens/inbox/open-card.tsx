import { useRef, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient, type PluginIdentity } from "@hercule/client-core";
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
import type { OpenCard } from "./use-open-card";
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

/** Returns what the shown id is: a place of the Inbox read, or else a card. */
const findPlaceView = (id: string, inbox: Inbox | undefined): PlaceView | undefined =>
  inbox === undefined ? undefined : readPlaceView(id, inbox);

/** Returns the name of the card or place `id`, for the dialog's name and for the way back. */
const nameShown = (id: string, inbox: Inbox | undefined): string => {
  const card = inbox?.cards.find((each) => each.id === id);
  if (card !== undefined) return card.title;
  return inbox?.places.find((each) => each.ref === id)?.title ?? "Back";
};

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
 *   folds the sheet (`openCard.close()`) before it plays the move.
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
  const { shownId } = sheet;
  if (shownId === null) return null;

  const readPlaces = (): SheetPlaces => {
    const places = readOpenCardPlaces(
      sheet.originElement,
      contentRef.current!,
      heldDestinationRef.current,
    );
    heldDestinationRef.current = places.destination;
    return places;
  };
  const placeView = findPlaceView(shownId, inbox);
  const backId = sheet.trail.at(-1);
  const userInitial = username.charAt(0).toUpperCase();
  return (
    <OpeningSheet
      isOpen={sheet.isOpen}
      contentKey={shownId}
      label={nameShown(shownId, inbox)}
      readPlaces={readPlaces}
      onClosed={() => {
        const origin = sheet.originElement;
        heldDestinationRef.current = null;
        sheet.finishClose();
        origin?.focus({ preventScroll: true });
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
        {backId !== undefined && (
          <button type="button" className="open-card-back" onClick={sheet.walkBack}>
            <ArrowIcon size={12} />
            <span>{nameShown(backId, inbox)}</span>
          </button>
        )}
        {placeView === undefined ? (
          <OpenCardContents
            key={shownId}
            id={shownId}
            inbox={inbox}
            client={client}
            plugins={plugins}
            userInitial={userInitial}
            onClose={openCard.close}
            onWalk={sheet.walkInside}
            moves={{ onTake, onDismiss, onSeeTask }}
          />
        ) : (
          <OpenPlaceBody
            view={placeView}
            plugins={plugins}
            onClose={openCard.close}
            onWalk={sheet.walkInside}
            onWalkCard={sheet.walkInside}
          />
        )}
      </div>
    </OpeningSheet>
  );
}
