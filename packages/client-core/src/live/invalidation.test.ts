import { describe, expect, it } from "vitest";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/query-core";
import { invalidateWithoutCancelling } from "./invalidation";

const KEY = ["tasks"];

/**
 * Returns a query client with one active query under `KEY`. Every read of it
 * waits until the test answers it with `answerRead`, and returns the
 * controller's version at the moment the read started, as a real read
 * returns the list as it was when the request arrived.
 */
const arrangeHeldQuery = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let version = 0;
  let reads = 0;
  let running = 0;
  let mostRunning = 0;
  const held: Array<{ readonly answer: () => void; readonly fail: () => void }> = [];
  const observer = new QueryObserver(queryClient, {
    queryKey: KEY,
    queryFn: ({ signal }) => {
      reads += 1;
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      const seen = version;
      return new Promise<number>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          running -= 1;
          reject(new Error("the read was cancelled"));
        });
        held.push({
          answer: () => {
            running -= 1;
            resolve(seen);
          },
          fail: () => {
            running -= 1;
            reject(new Error("the controller failed the read"));
          },
        });
      });
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    queryClient,
    held,
    changeVersion: (next: number) => {
      version = next;
    },
    countReads: () => reads,
    countMostRunning: () => mostRunning,
    readData: () => queryClient.getQueryData<number>(KEY),
    stop: unsubscribe,
  };
};

/** Resolves once every promise callback queued so far has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("invalidateWithoutCancelling", () => {
  it("keeps the running read through a burst of pushes, then reads once more and ends on the last state", async () => {
    const query = arrangeHeldQuery();
    await settle();
    expect(query.countReads()).toBe(1);

    for (let push = 1; push <= 10; push += 1) {
      query.changeVersion(push);
      invalidateWithoutCancelling(query.queryClient, KEY);
    }
    await settle();
    // The first read is still running: no push cancelled it or started another.
    expect(query.countReads()).toBe(1);

    query.held.shift()!.answer();
    await settle();
    // That read saw version 0, so exactly one more read starts after it.
    expect(query.countReads()).toBe(2);
    query.held.shift()!.answer();
    await settle();

    expect(query.readData()).toBe(10);
    expect(query.countReads()).toBe(2);
    expect(query.countMostRunning()).toBe(1);
    query.stop();
  });

  it("reads once more after a running read fails", async () => {
    const query = arrangeHeldQuery();
    await settle();
    query.changeVersion(1);
    invalidateWithoutCancelling(query.queryClient, KEY);

    query.held.shift()!.fail();
    await settle();
    expect(query.countReads()).toBe(2);
    query.held.shift()!.answer();
    await settle();

    expect(query.readData()).toBe(1);
    query.stop();
  });

  it("starts one read for a query that is not reading", async () => {
    const query = arrangeHeldQuery();
    await settle();
    query.held.shift()!.answer();
    await settle();

    query.changeVersion(1);
    invalidateWithoutCancelling(query.queryClient, KEY);
    await settle();
    expect(query.countReads()).toBe(2);
    query.held.shift()!.answer();
    await settle();

    expect(query.readData()).toBe(1);
    expect(query.countReads()).toBe(2);
    query.stop();
  });

  it("reads every page again when loading the next page cancels the push's read", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let version = 0;
    const held: Array<() => void> = [];
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: KEY,
      initialPageParam: 0,
      getNextPageParam: (last: { readonly page: number }) => (last.page === 0 ? 1 : undefined),
      queryFn: ({ pageParam }) => {
        const seen = version;
        return new Promise<{ readonly page: number; readonly version: number }>((resolve) => {
          held.push(() => resolve({ page: pageParam, version: seen }));
        });
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    const answerNewestRead = async () => {
      held.pop()!();
      await settle();
    };
    await settle();
    await answerNewestRead();

    version = 1;
    invalidateWithoutCancelling(queryClient, KEY);
    await settle();
    // Loading the next page cancels the push's read of the first page, and
    // reads only the second page.
    void observer.fetchNextPage();
    await settle();
    await answerNewestRead();
    // So the first page is read again, and the second page after it.
    await answerNewestRead();
    await answerNewestRead();

    expect(observer.getCurrentResult().data?.pages).toEqual([
      { page: 0, version: 1 },
      { page: 1, version: 1 },
    ]);
    unsubscribe();
  });
});
