import type { JSX, Ref } from "react";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  namePlugin,
  readErrorMessage,
  resolveDisplayTimezone,
  type HerculeClient,
} from "@hercule/client-core";
import {
  decideHandOff,
  describeBlocksUnreadable,
  describeDismissalReturn,
  describeHolderStrip,
  describePaneMeta,
  findAccountLabel,
  listPaneHistory,
  listPaneLinks,
  readHolder,
} from "@hercule/client-core/inbox";
import type { AccountScope } from "../../../app/account-scope";
import {
  entityQuery,
  inboxOutlineQuery,
  pluginsQuery,
  settingsQuery,
  userQuery,
} from "../../../app/queries";
import { InboxBlocks } from "../../../screens/inbox/inbox-blocks";
import { InboxPaneFooter } from "../../../screens/inbox/inbox-pane-footer";
import { InboxPaneThing, type InboxPaneBlocks } from "../../../screens/inbox/inbox-pane-thing";
import { InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import type { InboxAnswers } from "./-inbox-answers";
import { useInboxNow } from "./-inbox-clock";
import { InboxPaneAsks, type InboxPaneAsksHandle, type PaneReply } from "./-inbox-pane-asks";
import { useInboxPaneBlocks } from "./-use-inbox-pane-blocks";
import type { InboxListRow } from "./-inbox-visit";

/** The moves of the open thing, which the screen decides what to do with. */
export interface InboxPaneMoves {
  readonly onTakeOn: () => void;
  readonly onDismiss: () => void;
  readonly onGoToTask: () => void;
  /** Shows the thing linked to the open one, or says it is not in the list. */
  readonly onGoTo: (ref: string) => void;
  /** Starts the hand-off: hands at once with one workflow, else opens the menu under the button. */
  readonly onHandOff: () => void;
}

/**
 * Renders the pane of one thing: its title, meta line, who holds it, its asks
 * and blocks, what is linked to it and what happened, over the footer with the
 * moves that work.
 *
 * It reads the thing whole (`externalEntity.read`) and, after the thing has
 * been current for a moment, its blocks from the source. It shows quiet shapes
 * while the first read is on its way, and says why when it fails. With
 * `isActive` false (the pane lies over the list and is closed) nothing is
 * read, so stepping through the list reads no thing the user does not see.
 *
 * Stepping to another thing keeps this component mounted: the thing before
 * stays drawn, inert and marked busy, until the read of the new one answers,
 * and then the same elements show the new one.
 *
 * Orchestrating: it owns the two reads of the thing.
 */
export function InboxPaneThingPart({
  client,
  scope,
  thing,
  isActive,
  isHandMenuOpen,
  savedQueryKinds,
  chosenAskId,
  reply,
  answers,
  moves,
  asksRef,
  onChooseAsk,
  onReplyChange,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly thing: InboxListRow;
  readonly isActive: boolean;
  readonly isHandMenuOpen: boolean;
  readonly savedQueryKinds: readonly string[];
  readonly chosenAskId: string | null | undefined;
  readonly reply: PaneReply | null;
  readonly answers: InboxAnswers;
  readonly moves: InboxPaneMoves;
  readonly asksRef: Ref<InboxPaneAsksHandle>;
  readonly onChooseAsk: (signalId: string | null) => void;
  readonly onReplyChange: (reply: PaneReply | null) => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "/_connected/_shell" });
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const outline = useSuspenseQuery(inboxOutlineQuery(client)).data;
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const now = useInboxNow([thing]);
  const detail = useQuery({
    ...entityQuery(client, thing.id),
    enabled: isActive,
    placeholderData: keepPreviousData,
  });
  const blocks = useInboxPaneBlocks(client, thing.id, isActive);
  const record = detail.data;
  if (record === undefined) {
    return detail.isError ? (
      <p className="ib-pane-blocks-note">
        {`This thing could not be read. ${readErrorMessage(detail.error)}`}
      </p>
    ) : (
      <InboxPaneSkeleton />
    );
  }
  // True while `record` is the thing before's, kept drawn until this thing's read answers.
  const isStale = detail.isPlaceholderData;
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const sourceName = namePlugin(thing.source, plugins);
  const holder = readHolder(thing, username);
  const holdingHeading = describeHolderStrip(thing);
  const paneBlocks: InboxPaneBlocks =
    blocks.data !== undefined
      ? {
          state: "ready",
          content: <InboxBlocks blocks={blocks.data.blocks} timezone={timezone} now={now} />,
        }
      : blocks.isError
        ? { state: "failed", words: describeBlocksUnreadable(sourceName) }
        : { state: "loading" };
  return (
    <div className="ib-pane-content" aria-busy={isStale ? "true" : undefined} inert={isStale}>
      <InboxPaneThing
        title={record.title}
        identifier={record.identifier}
        meta={describePaneMeta(record, {
          account: findAccountLabel(
            outline.sources.find((source) => source.source === thing.source)?.accounts ?? [],
            thing.accounts,
          ),
          dismissalReturn: describeDismissalReturn(thing, now),
        })}
        holding={
          holder === undefined || holdingHeading === undefined
            ? undefined
            : { holder, heading: holdingHeading, taskName: thing.title }
        }
        asks={
          <InboxPaneAsks
            ref={asksRef}
            client={client}
            scope={scope}
            thing={thing}
            detail={record}
            isStale={isStale}
            savedQueryKinds={savedQueryKinds}
            chosenId={chosenAskId}
            reply={reply}
            sourceName={sourceName}
            timezone={timezone}
            now={now}
            platform={bridge.platform}
            answers={answers}
            onChoose={onChooseAsk}
            onReplyChange={onReplyChange}
          />
        }
        blocks={paneBlocks}
        links={listPaneLinks(record, plugins)}
        history={listPaneHistory(record, now)}
        plugins={plugins}
        onGoToTask={moves.onGoToTask}
        onGoTo={moves.onGoTo}
      />
      <InboxPaneFooter
        isTakenOn={thing.takenOn}
        handOff={decideHandOff(thing, thing.offers)}
        isHandMenuOpen={isHandMenuOpen}
        onTakeOn={moves.onTakeOn}
        onHandOff={moves.onHandOff}
        onDismiss={moves.onDismiss}
      />
    </div>
  );
}
