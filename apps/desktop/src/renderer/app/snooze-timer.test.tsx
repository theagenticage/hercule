/**
 * Tests `SnoozeTimer`: when it reads Intake's lists again so a snoozed
 * signal comes back to To do. The controller sends no push when a snooze
 * runs out, so this timer is the only thing that brings the signal back
 * while the app runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { Signal, SignalFilter } from "@hercule/contract";
import { signalsToDoQuery, snoozeTimerQuery } from "./queries";
import { SnoozeTimer } from "./snooze-timer";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const FIVE_MINUTES_MS = 5 * 60_000;

/** One read the timer made: which list it read, and when. */
interface Read {
  readonly view: SignalFilter["view"];
  readonly at: number;
}

/**
 * Renders the timer over a cache whose soonest `until` is `until`, or
 * nothing snoozed when it is `null`. A To do read is cached too, so a read
 * of every signal list reads To do. The controller moves the snoozed signal
 * off Later once its clock reaches `controllerRunsOutAt`, which is `until`
 * unless the test sets it later. A Later read answers `laterLatencyMs`
 * after it is sent, from the controller's state at that moment. Returns
 * every read made since, in the order they were sent.
 */
const renderSnoozeTimer = (
  until: string | null,
  controllerRunsOutAt = until === null ? 0 : Date.parse(until),
  laterLatencyMs = 0,
) => {
  const reads: Read[] = [];
  const isSnoozed = (): boolean => until !== null && Date.now() < controllerRunsOutAt;
  const client = {
    signal: {
      query: ({ query }: { readonly query: SignalFilter }) => {
        reads.push({ view: query.view, at: Date.now() });
        if (query.view !== "later") return Promise.resolve({ items: [] });
        const answerLater = () => ({
          items: isSnoozed() ? [{ snooze: { until } } as Signal] : [],
        });
        if (laterLatencyMs === 0) return Promise.resolve(answerLater());
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(answerLater());
          }, laterLatencyMs);
        });
      },
    },
  } as unknown as HerculeClient;
  const queryClient = new QueryClient();
  queryClient.setQueryData(snoozeTimerQuery(client).queryKey, until);
  render(
    <QueryClientProvider client={queryClient}>
      <SnoozeTimer client={client} />
    </QueryClientProvider>,
  );
  // An observer keeps To do active, as the shell does, so a read of every
  // signal list reads it.
  queryClient.setQueryData(signalsToDoQuery(client).queryKey, []);
  new QueryObserver(queryClient, signalsToDoQuery(client)).subscribe(() => {});
  return { reads, queryClient };
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SnoozeTimer", () => {
  it("reads the soonest until again one second after it runs out, not before", async () => {
    const { reads } = renderSnoozeTimer(new Date(NOW + FIVE_MINUTES_MS).toISOString());

    await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS));
    expect(reads).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(reads[0]?.view).toBe("later");
  });

  it("reads nothing while nothing is snoozed", async () => {
    const { reads } = renderSnoozeTimer(null);

    await act(() => vi.advanceTimersByTimeAsync(24 * 60 * 60_000));
    expect(reads).toEqual([]);
  });

  it("reads To do after the until read shows the snooze has left Later", async () => {
    const until = NOW + FIVE_MINUTES_MS;
    const { reads } = renderSnoozeTimer(new Date(until).toISOString());

    await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS + 1_000));
    // Query tells the component about the answer on a timer of its own.
    await act(() => vi.advanceTimersByTimeAsync(10));

    const emptyLater = reads.findIndex((read) => read.view === "later");
    const toDo = reads.findIndex((read) => read.view === "to-do");
    expect(emptyLater).toBeGreaterThanOrEqual(0);
    expect(toDo).toBeGreaterThan(emptyLater);
    expect(reads[toDo]!.at).toBeGreaterThanOrEqual(until);
  });

  it("reads To do after the controller moved the signal, even when Later answers after To do", async () => {
    // The controller's clock passes `until` while a Later read is on its
    // way, so that read finds Later empty. A To do read sent at the same
    // moment would still find the signal snoozed.
    const until = NOW + FIVE_MINUTES_MS;
    const controllerRunsOutAt = until + 1_050;
    const { reads } = renderSnoozeTimer(new Date(until).toISOString(), controllerRunsOutAt, 100);

    await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS + 2_000));
    const toDoReads = reads.filter((read) => read.view === "to-do");
    expect(toDoReads.at(-1)?.at).toBeGreaterThanOrEqual(controllerRunsOutAt);
  });

  it("reads To do again when a push read it just before the snooze ran out", async () => {
    const until = NOW + FIVE_MINUTES_MS;
    const { reads, queryClient } = renderSnoozeTimer(new Date(until).toISOString());

    // A push 50 ms before `until` reads To do while the signal is still on
    // Later. Without another read, To do would stay without it.
    await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS - 50));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.signals() }));
    const pushed = reads.length;

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    const after = reads.slice(pushed);
    expect(after.some((read) => read.view === "to-do" && read.at >= until)).toBe(true);
  });

  it("backs off to one read a minute while the controller's clock is behind", async () => {
    const until = NOW + FIVE_MINUTES_MS;
    const { reads } = renderSnoozeTimer(new Date(until).toISOString(), until + 10 * 60_000);

    await act(() => vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS + 5 * 60_000));
    const laterReads = reads.filter((read) => read.view === "later");
    // 1 s, then 1, 2, 4, 8, 16, 32 s, then once a minute: far fewer than one a second.
    expect(laterReads.length).toBeLessThan(15);
    const gaps = laterReads.slice(1).map((read, index) => read.at - laterReads[index]!.at);
    expect(Math.max(...gaps)).toBe(60_000);
  });

  it("waits for a until further away than one timer can, with no read before it", async () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60_000;
    const { reads } = renderSnoozeTimer(new Date(NOW + thirtyDaysMs).toISOString());

    await act(() => vi.advanceTimersByTimeAsync(thirtyDaysMs));
    expect(reads).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(reads[0]?.view).toBe("later");
  });

  it("brings back a snooze that runs out between a push's two reads, when nothing was snoozed before", async () => {
    // Snoozed elsewhere for half a second, then a push reads To do while
    // the signal is still on Later. The read stores the signal's until
    // before it reads To do, so the timer reads To do again once that until
    // has passed, though nothing was snoozed when the timer started.
    const until = NOW + 500;
    const { reads, queryClient } = renderSnoozeTimer(null);
    const snoozedClient = {
      signal: {
        query: ({ query }: { readonly query: SignalFilter }) => {
          reads.push({ view: query.view, at: Date.now() });
          const snoozed = Date.now() < until;
          if (query.view === "later") {
            return Promise.resolve({
              items: snoozed
                ? [{ snooze: { until: new Date(until).toISOString() } } as Signal]
                : [],
            });
          }
          return Promise.resolve({ items: [] });
        },
      },
    } as unknown as HerculeClient;
    await act(() => queryClient.fetchQuery({ ...signalsToDoQuery(snoozedClient), staleTime: 0 }));

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(reads.some((read) => read.view === "to-do" && read.at >= until)).toBe(true);
  });

  it("reads the until again when the window gets focus after it ran out while the Mac slept", async () => {
    const { reads } = renderSnoozeTimer(new Date(NOW + FIVE_MINUTES_MS).toISOString());

    // Moving the clock without running timers stands for the Mac sleeping.
    vi.setSystemTime(NOW + 2 * FIVE_MINUTES_MS);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads.map((read) => read.view)).toContain("to-do");
  });

  it("does not read on focus before the snooze runs out", async () => {
    const { reads } = renderSnoozeTimer(new Date(NOW + FIVE_MINUTES_MS).toISOString());

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads).toEqual([]);
  });
});
