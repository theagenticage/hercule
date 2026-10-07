/**
 * Tests `storeNewestMessages` and `storeSentMessage`: a fresh newest page,
 * or a message just sent, stored in the pages a Conversation holds, also
 * while an earlier page is being read, and never once the pages are gone.
 * Tests `removeQueryOnceUnobserved`, which drops those pages.
 */
import { describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createClient,
  flattenMessagePages,
  queryKeys,
  type MessagePage,
  type MessagePages,
} from "@hercule/client-core";
import { createApiStub } from "@hercule/client-core/testing";
import { removeQueryOnceUnobserved, storeNewestMessages, storeSentMessage } from "./queries";
import { buildFixtureAssistant, buildFixtureMessage, CONTROLLER_URL } from "./testing";

const ADA = buildFixtureAssistant({
  id: "01a06d02-a000-7000-8000-000000000005",
  name: "Ada",
  mainConversationId: "01a06d02-c000-7000-8000-000000000005",
});

const KEY = queryKeys.conversationMessages(ADA.mainConversationId);

/** Returns the page holding the messages from `from` to `to`, newest first. */
const buildPage = (
  { from, to }: { readonly from: number; readonly to: number },
  nextCursor?: string,
): MessagePage => ({
  items: Array.from({ length: to - from + 1 }, (_, index) =>
    buildFixtureMessage(ADA, { position: to - index, text: `Message ${String(to - index)}` }),
  ),
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

/** Returns the positions of the messages `queryClient` holds for Ada, oldest first. */
const readHeldPositions = (queryClient: QueryClient): number[] =>
  flattenMessagePages(queryClient.getQueryData<MessagePages>(KEY)?.pages ?? []).map(
    (message) => message.position,
  );

/** Returns a query client holding Ada's messages 1 to 4, in two pages. */
const holdFourMessages = (): QueryClient => {
  const queryClient = new QueryClient();
  queryClient.setQueryData<MessagePages>(KEY, {
    pages: [buildPage({ from: 3, to: 4 }, "3"), buildPage({ from: 1, to: 2 })],
    pageParams: [undefined, "3"],
  });
  return queryClient;
};

/**
 * Returns a client whose controller answers a read of Ada's messages with
 * `newest`, and records how many reads it was asked for.
 */
const answerNewestPage = (newest: MessagePage) => {
  const reads: string[] = [];
  const { fetch } = createApiStub({
    [`GET /api/v1/conversations/${ADA.mainConversationId}/messages`]: (call) => {
      reads.push(call.search);
      return { body: newest };
    },
  });
  return { client: createClient({ baseUrl: CONTROLLER_URL, fetch }), reads };
};

describe("storeNewestMessages", () => {
  it("merges the newest page into the pages held", async () => {
    const queryClient = holdFourMessages();

    await storeNewestMessages(
      queryClient,
      ADA.mainConversationId,
      buildPage({ from: 4, to: 5 }, "4"),
    );

    expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the merge when a read of an earlier page ends after it", async () => {
    const queryClient = new QueryClient();
    let answerEarlier: (page: MessagePage) => void = () => {};
    const queryFn = ({ pageParam }: { pageParam: string | undefined }) =>
      pageParam === undefined
        ? Promise.resolve(buildPage({ from: 3, to: 4 }, "3"))
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

    const stored = storeNewestMessages(
      queryClient,
      ADA.mainConversationId,
      buildPage({ from: 4, to: 5 }, "4"),
    );
    expect(readHeldPositions(queryClient)).toEqual([3, 4, 5]);
    answerEarlier(buildPage({ from: 1, to: 2 }));
    await earlier;
    await stored;

    expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4, 5]);
  });

  it("creates no entry once the pages are gone", async () => {
    const queryClient = new QueryClient();

    await storeNewestMessages(
      queryClient,
      ADA.mainConversationId,
      buildPage({ from: 4, to: 5 }, "4"),
    );

    expect(queryClient.getQueryCache().find({ queryKey: KEY })).toBeUndefined();
  });
});

describe("storeSentMessage", () => {
  it("merges a message that comes right after the newest one held, with no read", async () => {
    const queryClient = holdFourMessages();
    const { client, reads } = answerNewestPage(buildPage({ from: 5, to: 5 }));

    await storeSentMessage(
      queryClient,
      client,
      ADA.mainConversationId,
      buildFixtureMessage(ADA, { position: 5, text: "Message 5" }),
    );

    expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4, 5]);
    expect(reads).toEqual([]);
  });

  it("reads the newest page when more messages were stored since the newest one held", async () => {
    const queryClient = holdFourMessages();
    const { client, reads } = answerNewestPage(buildPage({ from: 4, to: 7 }, "4"));

    await storeSentMessage(
      queryClient,
      client,
      ADA.mainConversationId,
      buildFixtureMessage(ADA, { position: 7, text: "Message 7" }),
    );

    expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reads).toHaveLength(1);
  });

  it("stores nothing, and reads nothing, once the pages are gone", async () => {
    const queryClient = new QueryClient();
    const { client, reads } = answerNewestPage(buildPage({ from: 5, to: 5 }));

    await storeSentMessage(
      queryClient,
      client,
      ADA.mainConversationId,
      buildFixtureMessage(ADA, { position: 5, text: "Message 5" }),
    );

    expect(queryClient.getQueryCache().find({ queryKey: KEY })).toBeUndefined();
    expect(reads).toEqual([]);
  });
});

describe("removeQueryOnceUnobserved", () => {
  it("removes the query once the current commit has ended and nothing observes it", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = holdFourMessages();

      removeQueryOnceUnobserved(queryClient, KEY);
      expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4]);
      await vi.runAllTimersAsync();

      expect(queryClient.getQueryCache().find({ queryKey: KEY })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the query when an observer subscribes again before the check, as StrictMode does", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = holdFourMessages();

      removeQueryOnceUnobserved(queryClient, KEY);
      const unsubscribe = new QueryObserver(queryClient, {
        queryKey: KEY,
        enabled: false,
      }).subscribe(() => {});
      await vi.runAllTimersAsync();

      expect(readHeldPositions(queryClient)).toEqual([1, 2, 3, 4]);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
