import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { HerculeClient } from "@hercule/client-core";
import type { PluginDetail, Signal } from "@hercule/contract";
import { ageClock } from "../../app/age-clock";
import { pluginsQuery, signalsClearedTodayQuery } from "../../app/queries";
import { InboxZero } from "./inbox-zero";

// 10:00 on Tuesday 13 October in Amsterdam: the morning's line.
const NOW = new Date("2026-10-13T08:00:00.000Z");

/** Builds an installed, active plugin named `displayName`, which declares no mark. */
const buildPlugin = (id: string, displayName: string): PluginDetail => ({
  id,
  displayName,
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
});

/** Builds a signal of `kind` resolved by the user at `at`. */
const buildResolved = (id: number, kind: string, at: string): Signal => ({
  id: `01a06d02-7a00-7000-8000-${String(id).padStart(12, "0")}`,
  kind,
  origin: {
    type: "event",
    eventId: id,
    connectionId: "01a06d02-7200-7000-8000-000000000001",
    threadRef: `acme/webshop#${String(id)}`,
  },
  title: `Signal ${String(id)}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "resolved",
  createdAt: "2026-10-12T09:00:00.000Z",
  resolution: {
    kind: "decided",
    actionId: "approve",
    outcome: "Approved",
    actor: "user",
    origin: "api",
    at,
  },
});

/**
 * Renders inbox zero in Amsterdam with `done` as the Done list, read whole,
 * in a router that holds the `/_connected` route it reads its client from.
 * Every read is answered from the cache; the client never answers, so a read
 * the cache did not answer would leave the picture suspended.
 */
const renderInboxZero = async (
  done: ReadonlyArray<Signal>,
  {
    arriving = false,
    paneShown = false,
    onShowDone = () => {},
  }: {
    readonly arriving?: boolean;
    readonly paneShown?: boolean;
    readonly onShowDone?: (pluginId: string) => void;
  } = {},
): Promise<void> => {
  const client = new Proxy(
    {},
    {
      get: () => new Proxy({}, { get: () => () => new Promise(() => {}) }),
    },
  ) as HerculeClient;
  const queryClient = new QueryClient();
  queryClient.setQueryData(pluginsQuery(client).queryKey, [
    buildPlugin("sentry", "Sentry"),
    buildPlugin("github", "GitHub"),
    buildPlugin("linear", "Linear"),
  ]);
  queryClient.setQueryData(signalsClearedTodayQuery(client).queryKey, {
    pages: [{ items: [...done] }],
    pageParams: [undefined],
  });
  const root = createRootRouteWithContext<{ controller: { client: HerculeClient } }>()();
  const connected = createRoute({ getParentRoute: () => root, id: "_connected" });
  const intake = createRoute({
    getParentRoute: () => connected,
    path: "intake",
    component: () => (
      <InboxZero
        timezone="Europe/Amsterdam"
        arriving={arriving}
        paneShown={paneShown}
        onShowDone={onShowDone}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([connected.addChildren([intake])]),
    history: createMemoryHistory({ initialEntries: ["/intake"] }),
    context: { controller: { client } },
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Inbox zero" });
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  ageClock.refresh();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  act(() => ageClock.refresh());
});

describe("InboxZero", () => {
  it("shows the line for the time of day in the user's timezone", async () => {
    await renderInboxZero([]);

    expect(screen.getByText("The rest of the morning is yours.")).toBeDefined();
  });

  it("leaves out the count and the pills when nothing was cleared today", async () => {
    // 23:30 on Monday in Amsterdam: yesterday.
    await renderInboxZero([
      buildResolved(1, "github/review-requested", "2026-10-12T21:30:00.000Z"),
    ]);

    expect(screen.queryByText(/cleared today/)).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("counts what was cleared today, with a pill per plugin that opens Done on its tab", async () => {
    const onShowDone = vi.fn<(pluginId: string) => void>();
    await renderInboxZero(
      [
        buildResolved(1, "linear/mentioned", "2026-10-13T07:50:00.000Z"),
        buildResolved(2, "github/review-requested", "2026-10-13T07:40:00.000Z"),
        buildResolved(3, "github/mentioned", "2026-10-13T07:30:00.000Z"),
        // A core signal counts, but has no pill.
        buildResolved(4, "proposal", "2026-10-13T07:20:00.000Z"),
      ],
      { onShowDone },
    );

    expect(
      screen.getByText((_, element) => element?.textContent === "4 cleared today"),
    ).toBeDefined();
    const pills = screen.getAllByRole("button");
    // The plugins' order, not the count's: Sentry cleared nothing and has no pill.
    expect(pills.map((pill) => pill.getAttribute("aria-label"))).toEqual([
      "2 cleared from GitHub",
      "1 cleared from Linear",
    ]);
    act(() => {
      pills[1]!.click();
    });
    expect(onShowDone).toHaveBeenCalledWith("linear");
  });

  it("drops the arrival once it is over, so a part that mounts later does not play it", async () => {
    // The fake timers also run in real time, so the render's own waits still end.
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    await renderInboxZero([], { arriving: true });
    const picture = document.querySelector(".asks-zero");
    expect(picture?.classList.contains("is-arriving")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(picture?.classList.contains("is-arriving")).toBe(false);
  });

  it("waits for a closing pane, and stays arriving that much longer", async () => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    // No stylesheet sets the durations in tests, so the test sets the one the wait reads.
    document.documentElement.style.setProperty("--dur-3", "320ms");
    try {
      await renderInboxZero([], { arriving: true, paneShown: true });
      const picture = document.querySelector(".asks-zero");
      expect(picture?.classList.contains("waits-for-pane")).toBe(true);

      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(picture?.classList.contains("is-arriving")).toBe(true);

      act(() => {
        vi.advanceTimersByTime(320);
      });
      expect(picture?.classList.contains("is-arriving")).toBe(false);
    } finally {
      document.documentElement.style.removeProperty("--dur-3");
    }
  });
});
