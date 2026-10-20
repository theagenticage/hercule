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
 * `transcriptQuery` reads the whole transcript when the cache holds none,
 * merges only the rows after the ones held when it holds some, replaces them
 * when the controller's log was replaced, takes the whole transcript from a
 * controller that ignores `after`, and does not retry a read from held rows;
 * that `forgetGoneThread` reads the session before it deletes the copy; and
 * that `showThreadCopy` starts the read the copy needs.
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
  isNotFound,
} from "@hercule/client-core";
import type { TranscriptRow } from "@hercule/contract";
import { createApiStub } from "@hercule/client-core/testing";
import {
  ensureShellData,
  forgetGoneThread,
  previewSkillsQuery,
  readSenders,
  readSkillsIfStale,
  removeQueryOnceUnobserved,
  showThreadCopy,
  setupQuery,
  storeNewestMessages,
  storeSentMessage,
  transcriptQuery,
} from "./queries";
import { answerTranscriptRead, readTranscriptReads } from "./testing-transcript";
import type { ThreadCopies } from "./thread-copies";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureMessage,
  buildSidebarHandlers,
  CONTROLLER_URL,
  holdAnswer,
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

describe("transcriptQuery", () => {
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

  /** Returns the options that read the transcript again, as `fetchQuery` does for a stale one. */
  const readAgain = (client: HerculeClient) => ({
    ...transcriptQuery(client, sessionId),
    staleTime: 0,
  });

  it("reads the whole transcript when the cache holds none", async () => {
    const queryClient = new QueryClient();
    const { client, calls } = buildThreadClient();
    await queryClient.fetchQuery(transcriptQuery(client, sessionId));

    expect(readTranscriptReads(calls, sessionId)).toEqual([{ after: null, subagentId: null }]);
    expect(queryClient.getQueryData(transcriptKey)).toEqual(thread.transcript);
  });

  it("tries a failed whole read again", async () => {
    const queryClient = new QueryClient();
    let attempts = 0;
    const { fetch } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: (call) => {
        attempts += 1;
        if (attempts === 1) throw new Error("Network down.");
        return answerTranscriptRead(thread)(call);
      },
    });
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

    await queryClient.fetchQuery({ ...transcriptQuery(client, sessionId), retryDelay: 0 });

    expect(attempts).toBe(2);
    expect(queryClient.getQueryData(transcriptKey)).toEqual(thread.transcript);
  });

  it("reads from the last held row, checks it, and merges the rows after it", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows);
    const { client, calls } = buildThreadClient();
    await queryClient.fetchQuery(readAgain(client));

    // The read starts at the last held row, so its position is the one before.
    expect(readTranscriptReads(calls, sessionId)).toEqual([
      { after: String(heldRows.at(-2)!.position), subagentId: null },
    ]);
    expect(queryClient.getQueryData(transcriptKey)).toEqual(thread.transcript);
  });

  it("reads from the start when the copy holds one row", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows.slice(0, 1));
    const { client, calls } = buildThreadClient();
    await queryClient.fetchQuery(readAgain(client));

    expect(readTranscriptReads(calls, sessionId)).toEqual([{ after: "0", subagentId: null }]);
    expect(queryClient.getQueryData(transcriptKey)).toEqual(thread.transcript);
  });

  describe("when the controller's log was replaced since the copy was saved", () => {
    /** Returns the thread's rows as a restored log holds them: the same positions, other events. */
    const restoreRows = (rows: readonly TranscriptRow[]): TranscriptRow[] =>
      rows.map((row) => ({
        ...row,
        event: { ...row.event, eventId: `restored-${String(row.position)}` },
      }));

    it("replaces the held rows with the whole transcript when the new log reached the copy's last position", async () => {
      const restored = { ...thread, transcript: restoreRows(thread.transcript) };
      const queryClient = new QueryClient();
      queryClient.setQueryData(transcriptKey, heldRows);
      const { fetch, calls } = createApiStub({
        [`GET /api/v1/sessions/${sessionId}/transcript`]: answerTranscriptRead(restored),
      });
      const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

      await queryClient.fetchQuery(readAgain(client));

      // The first read finds another event at the last held position, so the
      // transcript is read in full.
      expect(readTranscriptReads(calls, sessionId)).toEqual([
        { after: String(heldRows.at(-2)!.position), subagentId: null },
        { after: null, subagentId: null },
      ]);
      expect(queryClient.getQueryData(transcriptKey)).toEqual(restored.transcript);
    });

    it("leaves no stale rows cached when the whole transcript cannot be read", async () => {
      const restored = { ...thread, transcript: restoreRows(thread.transcript) };
      const queryClient = new QueryClient();
      queryClient.setQueryData(transcriptKey, heldRows);
      const answerRestored = answerTranscriptRead(restored);
      const { fetch, calls } = createApiStub({
        [`GET /api/v1/sessions/${sessionId}/transcript`]: (call) => {
          // The first read (from the last held row) works; the full read fails.
          if (new URLSearchParams(call.search).get("after") === null) {
            throw new Error("Network down.");
          }
          return answerRestored(call);
        },
      });
      const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

      // `retry: false` keeps the test from waiting for the second try.
      await expect(
        queryClient.fetchQuery({ ...readAgain(client), retry: false }),
      ).rejects.toThrow();

      expect(readTranscriptReads(calls, sessionId)).toHaveLength(2);
      expect(queryClient.getQueryData(transcriptKey)).toEqual([]);
      expect(queryClient.getQueryState(transcriptKey)?.status).toBe("error");
    });

    it("replaces the held rows when the new log is shorter than the copy", async () => {
      const restored = { ...thread, transcript: restoreRows(thread.transcript.slice(0, 2)) };
      const queryClient = new QueryClient();
      queryClient.setQueryData(transcriptKey, heldRows);
      const { fetch } = createApiStub({
        [`GET /api/v1/sessions/${sessionId}/transcript`]: answerTranscriptRead(restored),
      });
      const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

      await queryClient.fetchQuery(readAgain(client));

      expect(queryClient.getQueryData(transcriptKey)).toEqual(restored.transcript);
    });
  });

  it("takes the whole transcript from a controller that ignores `after`, with one read and no empty cache", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows);
    const written: (readonly TranscriptRow[] | undefined)[] = [];
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") {
        written.push(event.query.state.data as readonly TranscriptRow[] | undefined);
      }
    });
    // An older controller answers from position 1 whatever `after` says.
    const { fetch, calls } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: { body: { items: thread.transcript } },
    });
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

    await queryClient.fetchQuery(readAgain(client));

    expect(readTranscriptReads(calls, sessionId)).toEqual([
      { after: String(heldRows.at(-2)!.position), subagentId: null },
    ]);
    expect(queryClient.getQueryData(transcriptKey)).toEqual(thread.transcript);
    expect(written.filter((rows) => rows?.length === 0)).toEqual([]);
  });

  it("logs once and keeps the held rows, without trying again, when a read from held rows fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows);
    const { fetch, calls } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: () => {
        throw new Error("Network down.");
      },
    });
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

    await expect(queryClient.fetchQuery(readAgain(client))).resolves.toBe(heldRows);

    expect(readTranscriptReads(calls, sessionId)).toHaveLength(1);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("fails at once, without logging, when a read from held rows finds the thread gone", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    queryClient.setQueryData(transcriptKey, heldRows);
    const { fetch, calls } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: {
        status: 404,
        body: buildErrorBody("not_found", "no such session"),
      },
    });
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

    await expect(queryClient.fetchQuery(readAgain(client))).rejects.toThrow();

    expect(readTranscriptReads(calls, sessionId)).toHaveLength(1);
    expect(logged).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(transcriptKey)).toEqual(heldRows);
    logged.mockRestore();
  });
});

describe("forgetGoneThread", () => {
  const thread = THREAD_FIXTURES.finished;
  const sessionId = thread.session.id;

  it("reads the session again before it deletes the copy, so a page that closes in between finds the thread gone", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.session(sessionId), thread.session);
    const sessionRead = holdAnswer();
    const { fetch } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}`]: sessionRead.handler,
    });
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });
    const deleteCopy = vi.fn(() => Promise.resolve());
    const threadCopies: ThreadCopies = {
      read: vi.fn(),
      save: vi.fn(),
      delete: deleteCopy,
      deleteAll: vi.fn(),
    };

    const forgotten = forgetGoneThread(queryClient, client, threadCopies, sessionId);
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.session(sessionId))?.fetchStatus).toBe("fetching");
    });
    // The read is out: the copy is still there, as is a session that exists.
    expect(deleteCopy).not.toHaveBeenCalled();

    sessionRead.answer({
      status: 404,
      body: buildErrorBody("not_found", "no such session"),
    });
    await forgotten;

    expect(isNotFound(queryClient.getQueryState(queryKeys.session(sessionId))?.error)).toBe(true);
    expect(deleteCopy).toHaveBeenCalledWith(sessionId);
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

  it("reads the rows after the copy's last row and merges them", async () => {
    const { fetch, calls } = createApiStub({
      [`GET /api/v1/sessions/${sessionId}/transcript`]: answerTranscriptRead(thread),
      [`GET /api/v1/sessions/${sessionId}`]: { body: thread.session },
      [`GET /api/v1/sessions/${sessionId}/subagents`]: { body: { items: [] } },
      [`GET /api/v1/sessions/${sessionId}/inputs`]: { body: { items: [] } },
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    });
    const queryClient = new QueryClient();
    const client = createClient({ baseUrl: CONTROLLER_URL, fetch });

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
