import type { ActionDispatch, JSX, Ref } from "react";
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
  describeUnreadable,
  findAccountLabel,
  findRowHolder,
  listPaneAsks,
  listPaneHistory,
  listPaneLinks,
  type PaneAskChoice,
  type PaneAskMove,
} from "@hercule/client-core/inbox";
import type { AccountScope } from "../../../app/account-scope";
import {
  entityBlocksQuery,
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
import { InboxPaneAsks, type InboxPaneAsksHandle } from "./-inbox-pane-asks";
import { useReadGate } from "./-use-read-gate";
import type { InboxListRow } from "./-inbox-visit";

/** The blocks slot while they are read. One shared object, so stepping from one loading thing to another leaves the slot as it is. */
const LOADING_BLOCKS: InboxPaneBlocks = { state: "loading" };

/** The moves of the open thing, which the screen decides what to do with. */
export interface InboxPaneMoves {
  readonly onTakeOn: () => void;
  readonly onDismiss: () => void;
  readonly onGoToTask: () => void;
  /** Shows the thing linked to the open one, or says it is not in the list. */
  readonly onGoTo: (ref: string) => void;
  /** Starts the hand-off: hands at once with one workflow, else opens the menu under the button. */
  readonly onHandOff: () => void;
  /** Starts the search for a thing to link this one to. */
  readonly onLink: () => void;
}

/**
 * Renders the pane of one thing: its title, meta line, who holds it, its asks
 * and blocks, what is linked to it and what happened, over the footer with the
 * moves that work.
 *
 * It reads the thing whole (`externalEntity.read`) and, after the thing has
 * been current for a moment, its blocks from the source (see `useReadGate`).
 * It shows quiet shapes while the first read is on its way, and says why when
 * it fails. With `isActive` false (the pane lies over the list and is closed)
 * nothing is read, so stepping through the list reads no thing the user does
 * not see.
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
  choice,
  answers,
  moves,
  asksRef,
  scrollRef,
  handAnchorRef,
  dispatchAskMove,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly thing: InboxListRow;
  readonly isActive: boolean;
  readonly isHandMenuOpen: boolean;
  readonly savedQueryKinds: readonly string[];
  /** What the user decided on the asks, which the asks part reads. */
  readonly choice: PaneAskChoice;
  readonly answers: InboxAnswers;
  readonly moves: InboxPaneMoves;
  readonly asksRef: Ref<InboxPaneAsksHandle>;
  /** The element that scrolls, and the hand-off button: the keys reach them through these. */
  readonly scrollRef: Ref<HTMLDivElement>;
  readonly handAnchorRef: Ref<HTMLButtonElement>;
  readonly dispatchAskMove: ActionDispatch<[move: PaneAskMove]>;
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
  // True while the record drawn is the thing before's, kept drawn until this thing's read answers.
  const isStale = detail.isPlaceholderData;
  const gate = useReadGate(thing.id, isActive, isStale);
  // A read that is out when the user steps on is aborted through the query's signal. No data shows for a
  // thing whose blocks were not read yet, so the blocks of one thing never show under another's title.
  const blocks = useQuery({
    ...entityBlocksQuery(client, thing.id),
    enabled: gate === "rested" || gate === "stale",
  });
  const record = detail.data;
  if (record === undefined) {
    return detail.isError ? (
      <p className="ib-pane-blocks-note">
        {describeUnreadable("thing", readErrorMessage(detail.error))}
      </p>
    ) : (
      <InboxPaneSkeleton />
    );
  }
  const timezone = resolveDisplayTimezone(settings.user.timezone);
  const sourceName = namePlugin(thing.source, plugins);
  const holder = findRowHolder(thing, username);
  const holdingHeading = describeHolderStrip(thing);
  const paneAsks = listPaneAsks(record);
  const hasAsks = paneAsks.sections.length > 0 || paneAsks.hiddenOpenCount > 0;
  // While the thing before's record is drawn, its title must not carry this thing's blocks.
  const paneBlocks: InboxPaneBlocks = isStale
    ? LOADING_BLOCKS
    : blocks.data !== undefined
      ? {
          state: "ready",
          content:
            blocks.data.blocks.length === 0 ? null : (
              <InboxBlocks blocks={blocks.data.blocks} timezone={timezone} now={now} />
            ),
        }
      : blocks.isError
        ? { state: "failed", words: describeBlocksUnreadable(sourceName) }
        : LOADING_BLOCKS;
  return (
    <div className="ib-pane-content" aria-busy={isStale ? "true" : undefined} inert={isStale}>
      <InboxPaneThing
        title={record.title}
        identifier={record.identifier}
        meta={describePaneMeta(record, {
          now,
          account: findAccountLabel(
            outline.sources.find((source) => source.source === thing.source)?.accounts ?? [],
            thing.accounts,
          ),
          dismissalReturn: describeDismissalReturn(thing, now),
        })}
        holding={
          holder === undefined || holdingHeading === undefined || thing.taskTitle === undefined
            ? undefined
            : { holder, heading: holdingHeading, taskName: thing.taskTitle }
        }
        asks={
          hasAsks ? (
            <InboxPaneAsks
              ref={asksRef}
              client={client}
              scope={scope}
              thing={thing}
              paneAsks={paneAsks}
              gate={gate}
              isShowingRecord={isActive && !isStale}
              savedQueryKinds={savedQueryKinds}
              choice={choice}
              sourceName={sourceName}
              timezone={timezone}
              now={now}
              platform={bridge.platform}
              answers={answers}
              dispatch={dispatchAskMove}
            />
          ) : null
        }
        blocks={paneBlocks}
        links={listPaneLinks(record, plugins)}
        history={listPaneHistory(record, now)}
        plugins={plugins}
        ref={scrollRef}
        onGoToTask={moves.onGoToTask}
        onGoTo={moves.onGoTo}
      />
      <InboxPaneFooter
        isTakenOn={thing.takenOn}
        handOff={decideHandOff(thing, thing.offers)}
        isHandMenuOpen={isHandMenuOpen}
        handAnchorRef={handAnchorRef}
        onTakeOn={moves.onTakeOn}
        onHandOff={moves.onHandOff}
        onLink={moves.onLink}
        onDismiss={moves.onDismiss}
      />
    </div>
  );
}
