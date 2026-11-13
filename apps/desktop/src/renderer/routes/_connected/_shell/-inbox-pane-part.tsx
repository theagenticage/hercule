import { useImperativeHandle, useRef, useState, type JSX, type Ref } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { namePlugin, type HerculeClient } from "@hercule/client-core";
import {
  describeInboxRow,
  findAccountLabel,
  readThingPlace,
  type InboxRowView,
} from "@hercule/client-core/inbox";
import type { InboxOrder } from "@hercule/contract";
import type { AccountScope } from "../../../app/account-scope";
import { inboxOutlineQuery, pluginsQuery, userQuery } from "../../../app/queries";
import { InboxPaneHead } from "../../../screens/inbox/inbox-pane-head";
import { INBOX_PANE_ID } from "../../../screens/inbox/inbox-pane-frame";
import {
  InboxSelectionHead,
  InboxSelectionPane,
} from "../../../screens/inbox/inbox-selection-pane";
import type { InboxAnswers } from "./-inbox-answers";
import { useInboxNow } from "./-inbox-clock";
import type { InboxPaneAsksHandle, PaneReply } from "./-inbox-pane-asks";
import { InboxPaneThingPart, type InboxPaneMoves } from "./-inbox-pane-thing-part";
import type { InboxListRow } from "./-inbox-visit";

export type { InboxPaneMoves };

/** What the keys ask of the pane. */
export interface InboxPaneHandle extends InboxPaneAsksHandle {
  /** Scrolls the pane down by a page, or up with `back`. */
  readonly scrollPage: (back: boolean) => void;
}

/**
 * Renders the line at the start of the pane's head: for one thing, its source,
 * its kind and its place (left out when it has none), and the account when the source has several; for a
 * selection, which sources the selected things come from.
 */
export function InboxPaneHeadPart({
  client,
  thing,
  selection,
}: {
  readonly client: HerculeClient;
  readonly thing: InboxListRow;
  /** The selected things when the pane shows a selection, else `null`. */
  readonly selection: ReadonlyArray<InboxListRow> | null;
}): JSX.Element {
  const outline = useSuspenseQuery(inboxOutlineQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const now = useInboxNow([thing]);
  if (selection !== null) {
    const sourceNames = [...new Set(selection.map((row) => namePlugin(row.source, plugins)))];
    return <InboxSelectionHead sourceNames={sourceNames} />;
  }
  const account = findAccountLabel(
    outline.sources.find((source) => source.source === thing.source)?.accounts ?? [],
    thing.accounts,
  );
  const place = readThingPlace(thing, now);
  return (
    <InboxPaneHead
      pluginId={thing.source}
      plugins={plugins}
      parts={[
        namePlugin(thing.source, plugins),
        thing.noun,
        ...(place === undefined ? [] : [place]),
      ]}
      account={account}
    />
  );
}

/**
 * Renders the pane of a selection: each selected thing as a row and Dismiss for
 * all of them. Orchestrating: it describes the rows with the user's name and
 * the time they show.
 */
function InboxSelectionPart({
  client,
  members,
  order,
  onWalk,
  onDismiss,
  onTakeOn,
  onLink,
}: {
  readonly client: HerculeClient;
  readonly members: ReadonlyArray<InboxListRow>;
  readonly order: InboxOrder;
  readonly onWalk: (ref: string) => void;
  readonly onDismiss: () => void;
  readonly onTakeOn: () => void;
  readonly onLink: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const now = useInboxNow(members);
  const views: InboxRowView[] = members.map((row) =>
    describeInboxRow(row, { order, now, userName: username, offers: row.offers }),
  );
  return (
    <InboxSelectionPane
      members={views}
      plugins={plugins}
      platform={bridge.platform}
      onWalk={onWalk}
      onTakeOn={onTakeOn}
      onLink={onLink}
      onDismiss={onDismiss}
    />
  );
}

/**
 * Renders the body of the pane: the pane of the selection when `selection`
 * holds things, else the pane of the current `thing`.
 *
 * It keeps what the user chose in the pane for as long as the screen lives:
 * the ask unfolded last for each thing (so walking away and back finds it as
 * it was left) and the reply box that is open. `ref` receives the handle the
 * keys use.
 *
 * Orchestrating: it owns those two pieces of client state.
 */
export function InboxPanePart({
  client,
  scope,
  thing,
  selection,
  order,
  isActive,
  isHandMenuOpen,
  savedQueryKinds,
  answers,
  moves,
  ref,
  onWalk,
  onDismissSelection,
  onTakeOnSelection,
  onLinkSelection,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly thing: InboxListRow;
  readonly selection: ReadonlyArray<InboxListRow> | null;
  readonly order: InboxOrder;
  readonly isActive: boolean;
  readonly isHandMenuOpen: boolean;
  /** The signal kinds of the saved query the user is on: the ask of such a kind is unfolded first. */
  readonly savedQueryKinds: readonly string[];
  readonly answers: InboxAnswers;
  readonly moves: InboxPaneMoves;
  readonly ref: Ref<InboxPaneHandle>;
  readonly onWalk: (ref: string) => void;
  readonly onDismissSelection: () => void;
  readonly onTakeOnSelection: () => void;
  readonly onLinkSelection: () => void;
}): JSX.Element {
  // The ask the user chose last for each thing, and whether they folded it.
  const [chosenAsks, setChosenAsks] = useState<
    ReadonlyMap<string, { readonly signalId: string; readonly isFolded: boolean }>
  >(new Map());
  const [reply, setReply] = useState<PaneReply | null>(null);
  const asksRef = useRef<InboxPaneAsksHandle>(null);
  useImperativeHandle(ref, () => ({
    answerCurrentAsk: () => {
      asksRef.current?.answerCurrentAsk();
    },
    stepAsk: (by) => {
      asksRef.current?.stepAsk(by);
    },
    scrollPage: (back) => {
      const scroller = document.getElementById(INBOX_PANE_ID)?.querySelector(".ib-pane-scroll");
      if (scroller === null || scroller === undefined) return;
      const page = scroller.clientHeight * 0.9;
      scroller.scrollBy({ top: back ? -page : page });
    },
  }));

  if (selection !== null) {
    return (
      <InboxSelectionPart
        client={client}
        members={selection}
        order={order}
        onWalk={onWalk}
        onDismiss={onDismissSelection}
        onTakeOn={onTakeOnSelection}
        onLink={onLinkSelection}
      />
    );
  }
  return (
    <InboxPaneThingPart
      client={client}
      scope={scope}
      thing={thing}
      isActive={isActive}
      isHandMenuOpen={isHandMenuOpen}
      savedQueryKinds={savedQueryKinds}
      chosenAskId={chosenAsks.get(thing.id)?.signalId}
      isAskFolded={chosenAsks.get(thing.id)?.isFolded ?? false}
      reply={reply}
      answers={answers}
      moves={moves}
      asksRef={asksRef}
      onChooseAsk={(signalId, isFolded) => {
        setChosenAsks((before) => new Map(before).set(thing.id, { signalId, isFolded }));
      }}
      onReplyChange={setReply}
    />
  );
}
