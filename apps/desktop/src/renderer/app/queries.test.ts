/**
 * Tests `storeNewestMessages`: a fresh newest page merged into the pages a
 * Conversation holds, also while an earlier page is being read.
 */
import { describe, expect, it } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import {
  flattenMessagePages,
  queryKeys,
  type MessagePage,
  type MessagePages,
} from "@hercule/client-core";
import { buildFixtureAssistant, buildFixtureMessage } from "../../app/testing";
import { storeNewestMessages } from "./use-conversation-live";

const ADA = buildFixtureAssistant({
  id: "01a06d02-a000-7000-8000-000000000005",
  name: "Ada",
  mainConversationId: "01a06d02-c000-7000-8000-000000000005",
});

const KEY = queryKeys.conversationMessages(ADA.mainConversationId);

/** Returns the page holding the messages from `last` down to `first`, newest first. */
const buildPage = (last: number, first: number, nextCursor?: string): MessagePage => ({
  items: Array.from({ length: last - first + 1 }, (_, index) =>
    buildFixtureMessage(ADA, { position: last - index, text: `Message ${String(last - index)}` }),
  ),
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

/** Returns the positions of the messages `queryClient` holds for Ada, oldest first. */
const readHeldPositions = (queryClient: QueryClient): number[] =>
  flattenMessagePages(queryClient.getQueryData<MessagePages>(KEY)?.pages ?? []).map(
    (message) => message.position,
  );

describe("storeNewestMessages", () => {
  it("merges the newest page into the pages held", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<MessagePages>(KEY, {
      pages: [buildPage(4, 3, "3"), buildPage(2, 1)],
      pageParams: [undefined, "3"],
    });

    await storeNewestMessages(queryClient, ADA.mainConversationId, buildPage(5, 4, "4"));

    expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the merge when a read of an earlier page ends after it", async () => {
    const queryClient = new QueryClient();
    let answerEarlier: (page: MessagePage) => void = () => {};
    const queryFn = ({ pageParam }: { pageParam: string | undefined }) =>
      pageParam === undefined
        ? Promise.resolve(buildPage(4, 3, "3"))
        : new Promise<MessagePage>((resolve) => {
            answerEarlier = resolve;
          });
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: KEY,
      queryFn,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page: MessagePage) => page.nextCursor,
    });
    await observer.refetch();
    const earlier = observer.fetchNextPage();
    // The read of the earlier page is on its way, and holds the pages as
    // they were when it started.

    const stored = storeNewestMessages(queryClient, ADA.mainConversationId, buildPage(5, 4, "4"));
    expect(readHeldPositions(queryClient)).toEqual([3, 4, 5]);
    answerEarlier(buildPage(2, 1));
    await earlier;
    await stored;

    expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4, 5]);
  });
});
