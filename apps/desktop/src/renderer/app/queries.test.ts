/**
 * Tests `storeNewestMessages` and `storeSentMessage`: a fresh newest page,
 * or a message just sent, stored in the pages a Conversation holds, also
 * while an earlier page is being read, and never once the pages are gone.
 * Tests `removeQueryOnceUnobserved`, which drops those pages, and that
 * `ensureShellData` keeps every read it loads. Tests `readSenders`, which
 * reads only the senders the shell's session lists do not hold. Tests
 * `readSkillsIfStale`, which reads the composer's skills again only when the
 * ones held are old. Tests that `setupQuery` is kept for the life of the
 * window, so the entry guard never waits for a second read. Tests that
 * `transcriptCatchUpQuery` merges only the rows after the ones held, and that
 * `showThreadCopy` starts the catch-up the copy needs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createClient,
  flattenMessagePages,
  type HerculeClient,
  queryKeys,
  type MessagePage,
  type MessagePages,
} from "@hercule/client-core";
import { createApiStub } from "@hercule/client-core/testing";
import {
  ensureShellData,
  previewSkillsQuery,
  readSenders,
  readSkillsIfStale,
  removeQueryOnceUnobserved,
  showThreadCopy,
  setupQuery,
  storeNewestMessages,
  storeSentMessage,
  transcriptCatchUpQuery,
} from "./queries";
import { answerTranscriptRead, readTranscriptReads } from "./testing-catch-up";
import type { ThreadCopies } from "./thread-copies";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureMessage,
  buildSidebarHandlers,
  CONTROLLER_URL,
  SIDEBAR_FIXTURE,
  THREAD_FIXTURES,
} from "./testing";

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

describe("ensureShellData", () => {
  // A shell read that Query removed while no component drew it would suspend
  // the whole app when a component that is not always on screen reads it
  // again. So every read the shell loads must stay cached, whoever draws it.
  it("keeps every read it loads for the life of the window", async () => {
    const { fetch } = createApiStub(buildSidebarHandlers(SIDEBAR_FIXTURE));
    const queryClient = new QueryClient();

    await ensureShellData(queryClient, createClient({ baseUrl: CONTROLLER_URL, fetch }));

    const kept = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [JSON.stringify(query.queryKey), query.gcTime]);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(kept.map(([key]) => [key, Infinity]));
  });
});

describe("setupQuery", () => {
  // The entry guard reads setup before every navigation. A read Query had
  // removed would put a round trip in front of the loaders of the next one.
  it("is not read again by a navigation made long after the first one", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = createApiStub({ "GET /api/v1/setup": { body: { complete: true } } });
      const queryClient = new QueryClient();
      const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

      await queryClient.ensureQueryData(setupQuery(client));
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await queryClient.ensureQueryData(setupQuery(client));

      expect(calls.filter((call) => call.path === "/api/v1/setup")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readSenders", () => {
  /** A session the sidebar's lists do not hold, as an archived one is. */
  const ARCHIVED = { ...SIDEBAR_FIXTURE.threads[0]!, id: "01a06d02-7400-7000-8000-0000000000b1" };

  it("reads only the senders the shell's session lists do not hold, once each", async () => {
    const listed = SIDEBAR_FIXTURE.threads[0]!;
    const { fetch, calls } = createApiStub({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      [`GET /api/v1/sessions/${ARCHIVED.id}`]: { body: ARCHIVED },
    });
    const queryClient = new QueryClient();
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

    await readSenders(queryClient, client, [listed.id, ARCHIVED.id]);
    await readSenders(queryClient, client, [listed.id, ARCHIVED.id]);

    const reads = calls.filter((call) => call.path.startsWith("/api/v1/sessions/"));
    expect(reads.map((call) => call.path)).toEqual([`/api/v1/sessions/${ARCHIVED.id}`]);
    expect(queryClient.getQueryData(queryKeys.sender(ARCHIVED.id))).toEqual(ARCHIVED);
  });
});

describe("readSkillsIfStale", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Returns a client whose skill preview fails or answers, and the spy that counts its reads. */
  const buildSkillsClient = (failing = false) => {
    const previewSkills = vi.fn(() =>
      failing ? Promise.reject(new Error("Runner offline.")) : Promise.resolve({ items: [] }),
    );
    return { client: { session: { previewSkills } } as unknown as HerculeClient, previewSkills };
  };

  it("reads once, and again only when the skills held are older than a few seconds", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const { client, previewSkills } = buildSkillsClient();
    const options = previewSkillsQuery(client, {});

    readSkillsIfStale(queryClient, options);
    await vi.advanceTimersByTimeAsync(0);
    expect(previewSkills).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    readSkillsIfStale(queryClient, options);
    await vi.advanceTimersByTimeAsync(0);
    expect(previewSkills).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    readSkillsIfStale(queryClient, options);
    await vi.advanceTimersByTimeAsync(0);
    expect(previewSkills).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure in the query and reads again the next time", async () => {
    const queryClient = new QueryClient();
    const { client, previewSkills } = buildSkillsClient(true);
    const options = previewSkillsQuery(client, {});

    readSkillsIfStale(queryClient, options);
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(options.queryKey)?.status).toBe("error");
    });
    readSkillsIfStale(queryClient, options);
    await vi.waitFor(() => {
      expect(previewSkills).toHaveBeenCalledTimes(2);
    });
  });
});

describe("transcriptCatchUpQuery", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;
  const transcriptKey = queryKeys.transcript(sessionId);
  const heldRows = thread.transcript.slice(0, 5);

  /** Returns a client whose controller answers from the finished thread, and the calls it gets. */
  const buildThreadClient = () => {
    const { fetch, calls } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: answerTranscriptRead(thread),
      [`GET /api/v1/sessions/${sessionId}`]: { body: thread.session },
    });
    return { client: createClient({ baseUrl: CONTROLLER_URL, fetch }), calls };
  };

  it("reads the rows after the last held row and merges them in one write", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows);
    const { client, calls } = buildThreadClient();
    await queryClient.fetchQuery(transcriptCatchUpQuery(client, sessionId));

    expect(readTranscriptReads(calls, sessionId)).toEqual([
      { after: String(heldRows.at(-1)!.position), subagentId: null },
    ]);
    expect(queryClient.getQueryData(transcriptKey)).toEqual(thread.transcript);
    // The first write is the held rows; the catch-up adds one more.
    expect(queryClient.getQueryState(transcriptKey)?.dataUpdateCount).toBe(2);
  });

  it("writes nothing when the transcript is no longer cached, so a missing start is not stored", async () => {
    const queryClient = new QueryClient();
    const { client } = buildThreadClient();

    await queryClient.fetchQuery(transcriptCatchUpQuery(client, sessionId));

    expect(queryClient.getQueryData(transcriptKey)).toBeUndefined();
  });

  it("reads the session again before it fails with not_found, so the session query holds the not_found", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows);
    const gone = { status: 404, body: buildErrorBody("not_found", "no such session") };
    const { fetch } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: gone,
      [`GET /api/v1/sessions/${sessionId}`]: gone,
    });
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

    await expect(
      queryClient.fetchQuery(transcriptCatchUpQuery(client, sessionId)),
    ).rejects.toThrow();

    expect(queryClient.getQueryState(queryKeys.session(sessionId))?.status).toBe("error");
  });
});

describe("showThreadCopy", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;
  const copy = {
    session: thread.session,
    subagents: [],
    queuedInputs: [],
    transcript: thread.transcript.slice(0, 5),
    subagentTranscripts: {},
  };

  it("runs the catch-up again when an earlier visit left its entry done", async () => {
    const { fetch, calls } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: answerTranscriptRead(thread),
      [`GET /api/v1/sessions/${sessionId}`]: { body: thread.session },
      [`GET /api/v1/sessions/${sessionId}/subagents`]: { body: { items: [] } },
      [`GET /api/v1/sessions/${sessionId}/inputs`]: { body: { items: [] } },
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    });
    const queryClient = new QueryClient();
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });
    queryClient.setQueryData(transcriptCatchUpQuery(client, sessionId).queryKey, true);

    const threadCopies: ThreadCopies = {
      read: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
      deleteAll: vi.fn(),
    };

    showThreadCopy(queryClient, client, threadCopies, copy);

    await vi.waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.transcript(sessionId))).toEqual(thread.transcript);
    });
    expect(readTranscriptReads(calls, sessionId)).toHaveLength(1);
  });
});
