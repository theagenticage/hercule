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
  listRefsNotToOffer,
  readOpenCardHandOff,
  readPlaceView,
  type EntityLinkMove,
  type PlaceView,
} from "@hercule/client-core/inbox";
import type { AddRow } from "@hercule/client-core/work";
import type { EntityRecord, Inbox } from "@hercule/contract";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { entityQuery, userQuery } from "../../app/queries";
import { ArrowIcon } from "../../icons/arrow";
import { LinkSearch, OpeningSheet, type SheetPlaces, type SheetRect } from "../desk";
import { OpenCardBody, OpenPlaceBody } from "./open-card-body";
import { OpenCardHandRows } from "./open-card-hand";
import { OpenCardLine } from "./open-card-line";
import { OpenCardLinked } from "./open-card-linked";
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
  /**
   * Hands the thing the sheet shows to the workflow `workflowId`. `by` is how
   * the user asked: by pointer, the page folds the sheet and plays the move on
   * the card where it lies; by keys, the sheet walks on to the next card and
   * the move plays behind it. The keys H and 1 to 3 are the page's, not the
   * sheet's.
   */
  readonly onHand: (workflowId: string, by: "keys" | "pointer") => void;
  /** Picks the account the hand-off acts as. */
  readonly onChooseConnection: (connectionId: string) => void;
  /** Goes to the card's Task on Work. Called with the Task's id. */
  readonly onSeeTask: (taskId: string) => void;
  /** Links two things as the user's own claim. The page plays the move and offers Undo. */
  readonly onLink: (move: EntityLinkMove) => void;
  /** Removes the user's own link between two things. The page plays the move and offers Undo. */
  readonly onUnlink: (move: EntityLinkMove) => void;
  /** Shows the open signals of the thing with this id, grouped, on Intake. */
  readonly onSeeInIntake: (entityId: string) => void;
}

/**
 * Returns the name of the card or place `target`, for the dialog's name and
 * for the way back. A card the Inbox does not list (a linked peer the sheet
 * walked to) is named by `readTitle`, the title from its own read, which the
 * sheet shares with the card's body.
 */
const nameTarget = (
  target: OpenTarget,
  inbox: Inbox | undefined,
  readTitle: (id: string) => string | undefined,
): string => {
  if (target.kind === "card") {
    return (
      inbox?.cards.find((each) => each.id === target.id)?.title ?? readTitle(target.id) ?? "Back"
    );
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
  chosenConnectionId,
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
  /** The account the user picked for the hand-off, or `undefined` for none. */
  readonly chosenConnectionId: string | undefined;
}): JSX.Element {
  const detail = useQuery(entityQuery(client, id));
  const listed = inbox?.cards.find((card) => card.id === id);
  const record: EntityRecord | undefined = detail.data ?? listed;
  const source =
    detail.data ?? (listed === undefined ? undefined : buildListedTimelineSource(listed));
  const cards = inbox?.cards ?? [];
  const lines = source === undefined ? [] : buildOpenTimeline(source, cards);
  const now = useOpenCardClock(record, lines);

  // What the card can be handed to: the read of the card once it has answered, else the Inbox's own sets.
  const { offers, actingConnections, openKinds } = readOpenCardHandOff(detail.data, listed, inbox);

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
            <LinkSearch
              client={client}
              size="compact"
              excludedRefs={listRefsNotToOffer(record.ref, detail.data.links)}
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
      hand={
        offers.available.length + offers.unavailable.length === 0 ? null : (
          <OpenCardHandRows
            offers={offers}
            openKinds={openKinds}
            actingConnections={actingConnections}
            chosenConnectionId={chosenConnectionId}
            onChooseConnection={moves.onChooseConnection}
            onHand={moves.onHand}
          />
        )
      }
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
  chosenConnectionId,
  onTake,
  onDismiss,
  onHand,
  onChooseConnection,
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
  /** The account the user picked for the hand-off of the card the sheet shows, or `undefined` for none. */
  readonly chosenConnectionId: string | undefined;
} & OpenCardMoveHandlers): JSX.Element | null {
  const { sheet } = openCard;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  // The cards the sheet names that the Inbox does not list: the one it shows and the one it came from.
  // Their reads are the ones the body makes, so no read is added for them.
  const findUnlistedCardId = (target: OpenTarget | undefined): string | undefined =>
    target?.kind === "card" && inbox?.cards.some((each) => each.id === target.id) !== true
      ? target.id
      : undefined;
  const backTarget = sheet.trail.at(-1);
  const shownCardId = findUnlistedCardId(sheet.shown ?? undefined);
  const backCardId = findUnlistedCardId(backTarget);
  const shownRead = useQuery({
    ...entityQuery(client, shownCardId ?? ""),
    enabled: shownCardId !== undefined,
  });
  const backRead = useQuery({
    ...entityQuery(client, backCardId ?? ""),
    enabled: backCardId !== undefined,
  });
  const readTitle = (id: string): string | undefined =>
    id === shownCardId
      ? shownRead.data?.title
      : id === backCardId
        ? backRead.data?.title
        : undefined;
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
  const back = backTarget;
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
      label={nameTarget(shown, inbox, readTitle)}
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
            <span>{nameTarget(back, inbox, readTitle)}</span>
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
            moves={{
              onTake,
              onDismiss,
              onHand,
              onChooseConnection,
              onSeeTask,
              onLink,
              onUnlink,
              onSeeInIntake,
            }}
            chosenConnectionId={chosenConnectionId}
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
