/**
 * An assistant's conversation screen: the messages of its web conversation as
 * a messenger, in the thread's 800px column, with a text-only composer at the
 * bottom.
 *
 * The screen shows conversation messages, not the session's transcript. The
 * work behind a reply is one "Show work" click away, on the session view.
 */
import { useLayoutEffect, useRef, type JSX } from "react";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  chooseMessageStamps,
  decideAssistantPresence,
  decideConversationActivity,
  flattenMessagePages,
  type HerculeClient,
  type Live,
} from "@hercule/client-core";
import { Button } from "@hercule/ui";
import { useLiveInvalidation } from "../../app/live-invalidation";
import {
  assistantQuery,
  conversationMessagesQuery,
  currentConversationSessionQuery,
} from "../../app/queries";
import { ContentColumn } from "../content-column";
import { readErrorMessage } from "../save-status";
import { findScrollingElement, useStickToBottom } from "../use-stick-to-bottom";
import { ActivityRow } from "./activity-row";
import { ConversationChrome } from "./conversation-chrome";
import { ConversationComposer } from "./conversation-composer";
import { ConversationMessageView } from "./conversation-message-view";

/**
 * Where the reader was when they asked for earlier messages: the first
 * message's row, where it sat in the viewport, and how far the page was
 * scrolled.
 */
interface ReadingPlace {
  readonly messageId: string;
  readonly top: number;
  readonly scrollTop: number;
}

/**
 * How many times "Show earlier messages" asks for the page before it gives
 * up. A re-read of the messages can cancel the load (see
 * `showEarlierMessages`), and a few re-reads in a row should not lose the
 * click.
 */
const MAX_PAGE_ATTEMPTS = 3;

export function ConversationScreen({
  client,
  live,
  assistantId,
  conversationId,
  timezone,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  readonly assistantId: string;
  readonly conversationId: string;
  /** The zone the timestamps are shown in. */
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  // A rename reaches the header, a new message the list, and a session
  // change the presence word and the activity row, all without a reload.
  useLiveInvalidation(live, queryClient, "assistant");
  useLiveInvalidation(live, queryClient, "conversation");
  useLiveInvalidation(live, queryClient, "session");

  const assistant = useSuspenseQuery(assistantQuery(client, assistantId)).data;
  const messages = useSuspenseInfiniteQuery(conversationMessagesQuery(client, conversationId));
  // The header's presence word and the activity row under the last message
  // both read this one session, so the two never disagree.
  const current = useSuspenseQuery(currentConversationSessionQuery(client, conversationId)).data;

  const lines = flattenMessagePages(messages.data.pages);
  const oldestId = lines[0]?.id;
  const newestId = lines.at(-1)?.id;
  const activity = decideConversationActivity(current);
  const stamps = chooseMessageStamps(lines, timezone);
  const { followIfAtBottom, scrollToBottom } = useStickToBottom();

  // A new message or a change in the activity row grows the column at the
  // bottom. The page follows only if the user was at the bottom, not while
  // they read back. The user counts as at the bottom until they scroll, so
  // the first run opens the conversation on its newest message.
  useLayoutEffect(() => {
    followIfAtBottom();
  }, [newestId, activity.kind, followIfAtBottom]);

  // Earlier messages load above the one the reader is looking at. Without a
  // correction, the page would keep its scroll offset and the reader would
  // jump to the top of the new page, so the row that was first is moved back
  // to where it was on screen. A reader who scrolled while the page loaded
  // has chosen a new place, so the page is left where they put it.
  const placeRef = useRef<ReadingPlace | null>(null);
  useLayoutEffect(() => {
    const place = placeRef.current;
    placeRef.current = null;
    if (place === null) return;
    const element = findScrollingElement();
    if (element.scrollTop !== place.scrollTop) return;
    const row = document.querySelector(`[data-message-id="${place.messageId}"]`);
    if (row === null) return;
    element.scrollTop += row.getBoundingClientRect().top - place.top;
  }, [oldestId]);

  const showEarlierMessages = async (): Promise<void> => {
    if (oldestId !== undefined) {
      const row = document.querySelector(`[data-message-id="${oldestId}"]`);
      if (row !== null)
        placeRef.current = {
          messageId: oldestId,
          top: row.getBoundingClientRect().top,
          scrollTop: findScrollingElement().scrollTop,
        };
    }
    const loaded = messages.data.pages.length;
    // A live nudge never cancels this load, but a re-read of the pages
    // already shown can: the composer re-reads them after a send, and that
    // cancels this load without an error. The page is asked for again until
    // it arrives, the load fails, or `MAX_PAGE_ATTEMPTS` is reached. A failed
    // load is not asked for again: its error shows beside the button, and the
    // user can click again.
    for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt += 1) {
      const result = await messages.fetchNextPage();
      if ((result.data?.pages.length ?? 0) > loaded) return;
      if (result.isFetchNextPageError || !result.hasNextPage) break;
    }
    // No page arrived, so there is no place to keep.
    placeRef.current = null;
  };

  return (
    <div className="flex flex-1 flex-col">
      <ConversationChrome name={assistant.name} presence={decideAssistantPresence(current)} />
      <ContentColumn className="gap-5">
        {/* The messages take the height the composer leaves, so the empty
            hint is centred in that space, not in the whole column. Their
            bottom padding and the column gap leave 40px above the composer,
            as on the session view. */}
        <div className="flex flex-1 flex-col gap-5 pb-5">
          {messages.hasNextPage ? (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="quiet"
                className="text-meta"
                disabled={messages.isFetchingNextPage}
                onClick={() => void showEarlierMessages()}
              >
                Show earlier messages
              </Button>
              {messages.isFetchNextPageError ? (
                <p className="text-fine text-fail" role="alert">
                  {readErrorMessage(messages.error)}
                </p>
              ) : null}
            </div>
          ) : null}
          {lines.length === 0 ? (
            <p className="my-auto text-center text-row text-muted">
              Send a message to start. {assistant.name} falls asleep after a quiet spell and picks
              up where it left off.
            </p>
          ) : (
            lines.map((message, index) => (
              <ConversationMessageView key={message.id} message={message} stamp={stamps[index]} />
            ))
          )}
          <ActivityRow activity={activity} name={assistant.name} />
        </div>
        <div className="sticky bottom-0">
          <ConversationComposer
            client={client}
            conversationId={conversationId}
            name={assistant.name}
            onSent={scrollToBottom}
          />
        </div>
      </ContentColumn>
    </div>
  );
}
