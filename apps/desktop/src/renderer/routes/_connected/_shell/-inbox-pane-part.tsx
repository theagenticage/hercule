import { useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildInitials,
  namePlugin,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  buildOpenTimeline,
  decideOpenCard,
  describeTimelineOverflow,
  findFirstOpenLine,
  type CardOffers,
} from "@hercule/client-core/inbox";
import type { InboxThing, WorkflowOffer } from "@hercule/contract";
import { entityQuery, inboxCountQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { OpenCardBody } from "../../../screens/inbox/open-card-body";
import { OpenCardHandRows } from "../../../screens/inbox/open-card-hand";
import { OpenCardLine } from "../../../screens/inbox/open-card-line";
import { OpenCardTimeline } from "../../../screens/inbox/open-card-timeline";
import { InboxPaneHead } from "../../../screens/inbox/inbox-pane-head";
import { InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import { useOpenCardClock } from "../../../screens/inbox/use-open-card-clock";

/** The moves of the open thing, which the screen decides what to do with. */
export interface InboxPaneMoves {
  readonly onTakeOn: () => void;
  readonly onDismiss: () => void;
  readonly onGoToTask: (taskId: string) => void;
  /** Hands the open thing to `offer`, as `connectionId` or the account the controller picks. */
  readonly onHandOff: (offer: WorkflowOffer, connectionId: string | undefined) => void;
  readonly onClose: () => void;
}

/**
 * Renders the line at the start of the pane's head for `thing`: its source,
 * its kind and its identifier, and the account when the source has several.
 */
export function InboxPaneHeadPart({
  client,
  thing,
}: {
  readonly client: HerculeClient;
  readonly thing: InboxThing;
}): JSX.Element {
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const accounts = counts.sources.find((source) => source.source === thing.source)?.accounts ?? [];
  const account =
    accounts.length > 1
      ? accounts.find((each) => thing.accounts.includes(each.connectionId))?.label
      : undefined;
  return (
    <InboxPaneHead
      pluginId={thing.source}
      plugins={plugins}
      parts={[namePlugin(thing.source, plugins), thing.noun, thing.identifier]}
      account={account}
    />
  );
}

/**
 * Renders the body of the pane for `thing`: today's open-card body, read with
 * `externalEntity.read`, until the pane's own content replaces it. It shows
 * quiet shapes while the read is on its way, and says why when it fails.
 * Keyed by the thing, so the opened line of the timeline starts over for each.
 *
 * Orchestrating: it owns the read and the choice of the open line.
 */
export function InboxPanePart({
  client,
  thing,
  offers,
  moves,
}: {
  readonly client: HerculeClient;
  readonly thing: InboxThing;
  /** The workflows the open thing can be handed to, which the pane's moves list. */
  readonly offers: CardOffers;
  readonly moves: InboxPaneMoves;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const detail = useQuery(entityQuery(client, thing.id));
  const record = detail.data;
  const lines = record === undefined ? [] : buildOpenTimeline(record, []);
  const now = useOpenCardClock(record, lines);
  // The card opens its first open line by itself, once it has one.
  const [chosenConnectionId, setChosenConnectionId] = useState<string | undefined>(undefined);
  const [chosenLine, setChosenLine] = useState<string | null | undefined>(undefined);
  const firstLine = record === undefined ? undefined : findFirstOpenLine(record.signals);
  if (chosenLine === undefined && firstLine !== undefined) setChosenLine(firstLine);

  if (record === undefined) {
    return detail.isError ? (
      <p className="open-card-trust">
        {`This thing could not be read. ${readErrorMessage(detail.error)}`}
      </p>
    ) : (
      <InboxPaneSkeleton />
    );
  }
  const words = decideOpenCard(record, record, record.kindAvailable, now);
  const timeline =
    lines.length === 0 ? null : (
      <OpenCardTimeline
        lines={lines}
        overflow={describeTimelineOverflow(record)}
        now={now}
        plugins={plugins}
        openLineId={chosenLine ?? undefined}
        onToggleLine={(signalId) => {
          setChosenLine((current) => (current === signalId ? null : signalId));
        }}
        onSeeInIntake={() => undefined}
        answers={(signalId) => (
          <OpenCardLine
            key={signalId}
            client={client}
            signalId={signalId}
            platform={bridge.platform}
          />
        )}
      />
    );
  return (
    <div className="open-card">
      <OpenCardBody
        url={record.url}
        words={words}
        plugins={plugins}
        userMonogram={buildInitials(username)}
        timeline={timeline}
        linked={null}
        hand={
          <OpenCardHandRows
            offers={offers}
            openKinds={thing.openKinds}
            actingConnections={thing.actingConnections}
            chosenConnectionId={chosenConnectionId}
            onChooseConnection={setChosenConnectionId}
            onHand={(workflowId) => {
              const offer = offers.available.find((each) => each.workflowId === workflowId);
              if (offer !== undefined) moves.onHandOff(offer, chosenConnectionId);
            }}
          />
        }
        onClose={moves.onClose}
        onWalk={() => undefined}
        onTake={moves.onTakeOn}
        onDismiss={moves.onDismiss}
        onSeeTask={moves.onGoToTask}
      />
    </div>
  );
}
