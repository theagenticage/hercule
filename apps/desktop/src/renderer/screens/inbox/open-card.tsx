import { useRef, useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildInitials,
  readErrorMessage,
  type HerculeClient,
  type PluginIdentity,
} from "@hercule/client-core";
import {
  buildLinkedRows,
  nameLinkedThing,
  readEntityPluginId,
  type OpenPlaceRow,
  type PlaceRow,
} from "@hercule/client-core/desk";
import {
  buildListedTimelineSource,
  buildOpenTimeline,
  buildWalkableIds,
  decideOpenCard,
  describeTimelineOverflow,
  findFirstOpenLine,
  readPlaceView,
  type EntityLinkMove,
  type PlaceView,
} from "@hercule/client-core/inbox";
import type { AddRow } from "@hercule/client-core/work";
import type { EntityRecord, Inbox } from "@hercule/contract";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { entityQuery, userQuery } from "../../app/queries";
import { ArrowIcon } from "../../icons/arrow";
import { OpeningSheet, type SheetPlaces, type SheetRect } from "../desk";
import { OpenCardBody, OpenPlaceBody } from "./open-card-body";
import { OpenCardLine } from "./open-card-line";
import { OpenCardLinked } from "./open-card-linked";
import { OpenCardLinkSearch } from "./open-card-link-search";
import { readOpenCardPlaces } from "./open-card-places";
import { OpenCardTimeline } from "./open-card-timeline";
import type { OpenCard, OpenTarget } from "./use-open-card";
import { useOpenCardClock } from "./use-open-card-clock";

/** What the open card needs of the page: the moves it offers. Each is called with the card's id. */
export interface OpenCardMoveHandlers {
  /** Takes the card on. The page folds the sheet and plays the move on the card. */
  readonly onTake: (cardId: string) => void;
  /** Dismisses the card. The page folds the sheet and plays the move on the card. */
  readonly onDismiss: (cardId: string) => void;
  /** Goes to the card's Task on Work. Called with the Task's id. */
  readonly onSeeTask: (taskId: string) => void;
  /** Links two things as the user's own claim. The page plays the move and offers Undo. */
  readonly onLink: (move: EntityLinkMove) => void;
  /** Removes the user's own link between two things. The page plays the move and offers Undo. */
  readonly onUnlink: (move: EntityLinkMove) => void;
  /** Shows the open signals of the thing with this id, grouped, on Intake. */
  readonly onSeeInIntake: (entityId: string) => void;
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
 * that answers, which also says whether the card's plugin is still active and
 * holds the card's signals, what changed at its source, and its links.
 *
 * - The card opens its newest open signal that is not snoozed, else its
 *   newest open one, and its answers are read with `signal.read` alone. The
 *   first open line is chosen once, so answering it does not open the next.
 * - Linking and unlinking go through the page's moves, so each is one gesture
 *   on the undo stack.
 *
 * Orchestrating: it owns the read and the choice of the open line.
 */
function OpenCardContents({
  id,
  inbox,
  client,
  plugins,
  platform,
  userMonogram,
  onClose,
  onWalk,
  onWalkCard,
  moves,
}: {
  readonly id: string;
  readonly inbox: Inbox | undefined;
  readonly client: HerculeClient;
  readonly plugins: readonly PluginIdentity[];
  readonly platform: DesktopPlatform;
  readonly userMonogram: string;
  readonly onClose: () => void;
  readonly onWalk: (ref: string) => void;
  readonly onWalkCard: (id: string) => void;
  readonly moves: OpenCardMoveHandlers;
}): JSX.Element {
  const detail = useQuery(entityQuery(client, id));
  const listed = inbox?.cards.find((card) => card.id === id);
  const record: EntityRecord | undefined = detail.data ?? listed;
  const source =
    detail.data ?? (listed === undefined ? undefined : buildListedTimelineSource(listed));
  const cards = inbox?.cards ?? [];
  const lines = source === undefined ? [] : buildOpenTimeline(source, cards);
  const now = useOpenCardClock(record, lines);

  // The card opens one line by itself, the first time it has one to open.
  const [chosenLine, setChosenLine] = useState<string | null | undefined>(undefined);
  const firstLine = detail.data === undefined ? undefined : findFirstOpenLine(detail.data.signals);
  if (chosenLine === undefined && firstLine !== undefined) setChosenLine(firstLine);

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
  const timeline =
    lines.length === 0 ? null : (
      <OpenCardTimeline
        lines={lines}
        overflow={detail.data === undefined ? undefined : describeTimelineOverflow(detail.data)}
        now={now}
        plugins={plugins}
        openLineId={chosenLine ?? undefined}
        onToggleLine={(signalId) => {
          setChosenLine((current) => (current === signalId ? null : signalId));
        }}
        onSeeInIntake={() => {
          moves.onSeeInIntake(id);
        }}
        answers={(signalId) => (
          <OpenCardLine key={signalId} client={client} signalId={signalId} platform={platform} />
        )}
      />
    );

  const buildMove = (toRef: string, toName: string): EntityLinkMove => ({
    fromRef: record.ref,
    toRef,
    fromName: record.identifier,
    toName,
  });
  // A linked thing opens inside the sheet when it has an id to read: a card of this page, or a peer that is a full record.
  const walkableIds = buildWalkableIds(detail.data?.peers ?? [], cards);
  const linked =
    detail.data === undefined ? null : (
      <OpenCardLinked
        rows={buildLinkedRows({ ...detail.data, plugins })}
        plugins={plugins}
        canWalk={(row) => walkableIds.has(row.ref)}
        onWalk={(ref) => {
          const walkId = walkableIds.get(ref);
          if (walkId !== undefined) onWalkCard(walkId);
        }}
        onUnlink={(row: PlaceRow) => {
          moves.onUnlink(buildMove(row.ref, nameLinkedThing(row)));
        }}
        onLink={(row: OpenPlaceRow) => {
          moves.onLink(buildMove(row.ref, nameLinkedThing(row)));
        }}
        search={
          words.moves._tag === "off" ? null : (
            <OpenCardLinkSearch
              client={client}
              selfRef={record.ref}
              links={detail.data.links}
              ownPluginId={readEntityPluginId(record.kind)}
              onPick={(row: AddRow) => {
                moves.onLink(buildMove(row.ref, row.identifier));
              }}
            />
          )
        }
      />
    );
  return (
    <OpenCardBody
      url={record.url}
      words={words}
      plugins={plugins}
      userMonogram={userMonogram}
      timeline={timeline}
      linked={linked}
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
 * - `platform` is the platform the app runs on, which decides the key that
 *   sends a reply written under an opened line.
 *
 * The page renders it once, in the desk's `overlays`. It draws nothing while
 * nothing is open.
 */
export function InboxOpenCard({
  openCard,
  client,
  inbox,
  plugins,
  platform,
  onTake,
  onDismiss,
  onSeeTask,
  onLink,
  onUnlink,
  onSeeInIntake,
}: {
  readonly openCard: OpenCard;
  readonly client: HerculeClient;
  readonly inbox: Inbox | undefined;
  readonly plugins: readonly PluginIdentity[];
  readonly platform: DesktopPlatform;
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
  const userMonogram = buildInitials(username);
  return (
    <OpeningSheet
      isOpen={sheet.isOpen}
      contentKey={keyTarget(shown)}
      label={nameTarget(shown, inbox)}
      className="open-card-sheet"
      followsContent
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
            platform={platform}
            userMonogram={userMonogram}
            onClose={openCard.close}
            onWalk={walkToPlace}
            onWalkCard={walkToCard}
            moves={{ onTake, onDismiss, onSeeTask, onLink, onUnlink, onSeeInIntake }}
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
