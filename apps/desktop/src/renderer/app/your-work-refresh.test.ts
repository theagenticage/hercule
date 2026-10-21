/**
 * Tests `startYourWorkRefresh` with the real query cache: Your work is read
 * again when the thread refs of the To do list stop matching the ones it was
 * read for, from a read of To do or from a write to its cached list, never two
 * reads at once, never throwing a finished read away, and with no request for a
 * change that keeps the refs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys, type HerculeClient, type YourWorkRead } from "@hercule/client-core";
import type { Signal } from "@hercule/contract";
import { signalsToDoQuery, yourWorkQuery } from "./queries";
import { startYourWorkRefresh } from "./your-work-refresh";

const AT = "2026-10-20T10:00:00.000Z";

const buildSignal = (n: number, threadRef = `github:pr:acme/shop#${n}`): Signal => ({
  id: `s${n}`,
  kind: "github/checks-failed",
  origin: { type: "event", eventId: n, connectionId: "conn", threadRef },
  title: "Checks failed",
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: AT,
});

const buildCoreSignal = (n: number): Signal => ({
  ...buildSignal(n),
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
});

/** What the test stops after it: the cache and the observers that keep the shell's reads active. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Builds a cache for the shell: To do and Your work both observed, as the
 * shell's components do, and a controller whose To do list the test sets. A
 * read of Your work's Tasks waits until the test answers it, so the test
 * decides what happens while a read is under way.
 */
const buildShell = (initialSignals: ReadonlyArray<Signal>) => {
  let signals = initialSignals;
  const taskReads: Array<{ refs: ReadonlyArray<string>; answer: () => void }> = [];
  let readsRunning = 0;
  let mostReadsRunning = 0;
  const client = {
    signal: {
      query: ({ query }: { query: { view: string } }) =>
        Promise.resolve({ items: query.view === "later" ? [] : signals }),
    },
    task: {
      query: ({ query }: { query: { refs: ReadonlyArray<string> } }) =>
        new Promise((resolve) => {
          readsRunning += 1;
          mostReadsRunning = Math.max(mostReadsRunning, readsRunning);
          taskReads.push({
            refs: query.refs,
            answer: () => {
              readsRunning -= 1;
              resolve({ items: [] });
            },
          });
        }),
    },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const toDo = signalsToDoQuery(client);
  const yourWork = yourWorkQuery(client);
  return {
    client,
    queryClient,
    taskReads,
    mostReadsRunning: () => mostReadsRunning,
    readYourWork: () => queryClient.getQueryData<YourWorkRead>(queryKeys.yourWork()),
    /** Subscribes the observers of the shell's components, which make the reads active. */
    observe: () => {
      cleanups.push(new QueryObserver(queryClient, toDo).subscribe(() => {}));
      cleanups.push(new QueryObserver(queryClient, yourWork).subscribe(() => {}));
    },
    /** Changes what the controller answers and reads To do again, as a push on the `signal` topic does. */
    pushSignals: async (next: ReadonlyArray<Signal>) => {
      signals = next;
      await queryClient.fetchQuery({ ...toDo, staleTime: 0 });
    },
    /** Answers the oldest Task read that waits, and lets the cache react. */
    answerNextTaskRead: async () => {
      await vi.waitFor(() => {
        expect(taskReads.length).toBeGreaterThan(0);
      });
      taskReads.shift()!.answer();
      await vi.waitFor(() => {
        expect(queryClient.isFetching({ queryKey: queryKeys.yourWork() })).toBe(
          taskReads.length > 0 ? 1 : 0,
        );
      });
    },
    toDoOptions: toDo,
  };
};

describe("startYourWorkRefresh", () => {
  it("keeps every finished read under a stream of ref changes, one read at a time", async () => {
    const shell = buildShell([buildSignal(1)]);
    cleanups.push(startYourWorkRefresh(shell.queryClient));
    shell.observe();
    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });

    // A signal with a new thread ref arrives while each read is under way.
    for (let n = 2; n <= 6; n++) {
      await shell.pushSignals(Array.from({ length: n }, (_, index) => buildSignal(index + 1)));
      await shell.answerNextTaskRead();
      // The read that just finished is stored with the refs it was made for ...
      expect(shell.readYourWork()?.refs).toHaveLength(n - 1);
      // ... and the next one has started for the newest refs.
      await vi.waitFor(() => {
        expect(shell.taskReads).toHaveLength(1);
      });
      expect(shell.taskReads[0]!.refs).toHaveLength(n);
    }

    // Once the changes stop, the last read matches the signals and no more start.
    await shell.answerNextTaskRead();
    expect(shell.readYourWork()?.refs).toHaveLength(6);
    expect(shell.taskReads).toHaveLength(0);
    expect(shell.mostReadsRunning()).toBe(1);
  });

  it("reads again after a read that a change overtook, whichever write made the change", async () => {
    const shell = buildShell([buildSignal(1)]);
    cleanups.push(startYourWorkRefresh(shell.queryClient));
    shell.observe();
    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });

    // The cold read has no answer yet: the change finds nothing to compare with.
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [buildSignal(1), buildSignal(2)]);
    await shell.answerNextTaskRead();

    expect(shell.readYourWork()?.refs).toEqual(["github:pr:acme/shop#1"]);
    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });
    expect(shell.taskReads[0]!.refs).toEqual(["github:pr:acme/shop#1", "github:pr:acme/shop#2"]);
  });

  it("reads for the ref of a signal that an optimistic write puts back, as the undo of a move does", async () => {
    const shell = buildShell([buildSignal(1), buildSignal(2)]);
    cleanups.push(startYourWorkRefresh(shell.queryClient));
    shell.observe();
    await shell.answerNextTaskRead();
    expect(shell.readYourWork()?.refs).toHaveLength(2);

    // The move takes the signal off the list ...
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [buildSignal(1)]);
    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });
    await shell.answerNextTaskRead();
    expect(shell.readYourWork()?.refs).toEqual(["github:pr:acme/shop#1"]);

    // ... and the undo puts it back, on a thread the last read did not ask for.
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [
      buildSignal(1),
      buildSignal(2, "github:pr:acme/shop#9"),
    ]);
    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });
    expect(shell.taskReads[0]!.refs).toEqual(["github:pr:acme/shop#1", "github:pr:acme/shop#9"]);
  });

  it("makes no request for a change to To do that keeps the thread refs", async () => {
    const shell = buildShell([buildSignal(1)]);
    cleanups.push(startYourWorkRefresh(shell.queryClient));
    shell.observe();
    await shell.answerNextTaskRead();
    const stored = shell.readYourWork();

    // A second signal on the same thread, a signal of the app's own, a read of To do that
    // changes nothing, and a signal that leaves.
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [
      buildSignal(1),
      buildSignal(7, "github:pr:acme/shop#1"),
      buildCoreSignal(8),
    ]);
    await shell.pushSignals([buildSignal(1), buildCoreSignal(8)]);
    await shell.pushSignals([buildSignal(1)]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(shell.taskReads).toHaveLength(0);
    expect(shell.readYourWork()).toBe(stored);
  });

  it("does not read again after a read whose refs To do still has, though the last stored read had others", async () => {
    const shell = buildShell([buildSignal(1)]);
    cleanups.push(startYourWorkRefresh(shell.queryClient));
    shell.observe();
    await shell.answerNextTaskRead();

    // The new ref starts a read ...
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [buildSignal(1), buildSignal(2)]);
    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });
    // ... and a change that keeps the refs lands while it runs.
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [
      buildSignal(1),
      buildSignal(2),
      buildCoreSignal(3),
    ]);
    await shell.answerNextTaskRead();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(shell.readYourWork()?.refs).toHaveLength(2);
    expect(shell.taskReads).toHaveLength(0);
  });

  it("reads at once for a change that came before it started, as the shell mounts", async () => {
    const shell = buildShell([buildSignal(1)]);
    shell.observe();
    await shell.answerNextTaskRead();
    // To do changes between the shell's loader and the shell mounting.
    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [buildSignal(1), buildSignal(2)]);
    expect(shell.taskReads).toHaveLength(0);

    cleanups.push(startYourWorkRefresh(shell.queryClient));

    await vi.waitFor(() => {
      expect(shell.taskReads).toHaveLength(1);
    });
    expect(shell.taskReads[0]!.refs).toHaveLength(2);
  });

  it("stops reading once it is stopped", async () => {
    const shell = buildShell([buildSignal(1)]);
    const stop = startYourWorkRefresh(shell.queryClient);
    shell.observe();
    await shell.answerNextTaskRead();
    stop();

    shell.queryClient.setQueryData(shell.toDoOptions.queryKey, [buildSignal(1), buildSignal(2)]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(shell.taskReads).toHaveLength(0);
  });
});
