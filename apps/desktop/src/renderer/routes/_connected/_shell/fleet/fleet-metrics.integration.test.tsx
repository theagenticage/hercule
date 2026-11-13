/**
 * Tests how the Fleet pages read and follow Runner Metrics (spec 17 §Graphs
 * and the forecast): the histories each page reads as it opens, what a
 * `runnerMetrics` push reads again, how pushes that arrive during a read are
 * folded together, the Fleet page's hour history that is read again at most
 * once an hour, and a hidden window that reads nothing.
 */
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import type { Runner, RunnerMetricsPoint, RunnerMetricsResolution } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
} from "../../../../app/testing";
import { rememberMachineView } from "../../../../screens/fleet/machine-view";

/** Every `machine` prop each card was drawn with, oldest first, by runner id. */
const { drawnMachines } = vi.hoisted(() => ({ drawnMachines: new Map<string, unknown[]>() }));

vi.mock("../../../../screens/fleet/machine-card", async (importActual) => {
  const actual = await importActual<typeof import("../../../../screens/fleet/machine-card")>();
  return {
    ...actual,
    MachineCard: (props: ComponentProps<typeof actual.MachineCard>) => {
      const held = drawnMachines.get(props.machine.runnerId) ?? [];
      drawnMachines.set(props.machine.runnerId, [...held, props.machine]);
      return <actual.MachineCard {...props} />;
    },
  };
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const GIB = 1024 ** 3;
const POINT_MS: Readonly<Record<RunnerMetricsResolution, number>> = {
  fiveMinutes: 5 * MINUTE_MS,
  hour: HOUR_MS,
};

beforeEach(() => {
  stubIntersectionObserver();
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers({ now: new Date("2026-11-02T14:02:00.000Z"), toFake: ["Date"] });
  drawnMachines.clear();
  rememberMachineView("grid");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setVisibility("visible");
  localStorage.clear();
});

const buildRunner = (id: string, name: string): Runner => ({
  id,
  name,
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 16 * GIB,
    diskTotalBytes: 500_000_000_000,
    docker: false,
    toolchains: [],
    harnesses: [],
    adapters: [],
    identityPort: 4939,
  },
  metrics: {
    diskFreeBytes: 100_000_000_000,
    availableMemoryBytes: 8 * GIB,
    cpu: { averagePercent: 23, peakPercent: 61 },
  },
  diskUsage: null,
  maxConcurrentSessions: 8,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T14:01:00.000Z",
});

const ATLAS = buildRunner("01a06d02-a000-7000-8000-000000000001", "atlas");
const FORGE = buildRunner("01a06d02-a000-7000-8000-000000000002", "forge");

/** Returns a point of `runner` starting at `at`, with the free disk and the CPU average telling points apart. */
const buildPoint = (
  runner: Runner,
  at: string,
  over: Partial<RunnerMetricsPoint> = {},
): RunnerMetricsPoint => ({
  runnerId: runner.id,
  at,
  minutes: 5,
  diskFreeBytes: 100_000_000_000,
  availableMemoryBytes: 8 * GIB,
  availableMemoryLowestBytes: 7 * GIB,
  cpuAveragePercent: 20,
  cpuPeakPercent: 40,
  sessionsRunning: 1,
  sessionsQueued: 0,
  ...over,
});

/** What the controller holds, which a test changes between pushes, and a read it can keep waiting. */
interface World {
  runners: Runner[];
  points: Record<RunnerMetricsResolution, RunnerMetricsPoint[]>;
  /** While set for a resolution, a read of its points waits for it. */
  hold: Partial<Record<RunnerMetricsResolution, Promise<void>>>;
  /** How many points a page holds. A later page also finds the clock an hour on. Unlimited when left out. */
  pageSize?: number;
}

/** One `runnerMetrics.query` request, as the controller received it. */
interface MetricsRead {
  readonly resolution: RunnerMetricsResolution;
  readonly runnerId: string | null;
  readonly since: string;
  readonly until: string;
}

const readMetricsCalls = (calls: readonly Call[]): readonly MetricsRead[] =>
  calls
    .filter((call) => call.method === "GET" && call.path === "/api/v1/runner-metrics")
    .map((call) => {
      const query = new URLSearchParams(call.search);
      return {
        resolution: query.get("resolution") as RunnerMetricsResolution,
        runnerId: query.get("runnerId"),
        since: query.get("since")!,
        until: query.get("until")!,
      };
    });

const readFiveMinuteCalls = (calls: readonly Call[]) =>
  readMetricsCalls(calls).filter((read) => read.resolution === "fiveMinutes");

const readHourCalls = (calls: readonly Call[]) =>
  readMetricsCalls(calls).filter((read) => read.resolution === "hour");

const countRunnerReads = (calls: readonly Call[]): number =>
  calls.filter((call) => call.method === "GET" && call.path === "/api/v1/runners").length;

/**
 * Opens the app at `path` with the runners atlas and forge, and a controller
 * that answers `runnerMetrics.query` from `world`, the way it does: the points
 * from the start of the point that holds `since`, of the runner when one is
 * named.
 */
const openApp = async (path: string, world: World) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [ATLAS, FORGE] }),
    "GET /api/v1/runners": () => ({ body: { items: world.runners } }),
    "GET /api/v1/sessions": { body: { items: [] } },
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-c000-7000-8000-000000000001",
        publicKey: "key",
        version: "0.9.3",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: { model: null, unavailableReason: null, lastFailure: null },
      },
    },
    "GET /api/v1/runner-metrics": async (call) => {
      const query = new URLSearchParams(call.search);
      const resolution = query.get("resolution") as RunnerMetricsResolution;
      const runnerId = query.get("runnerId");
      const since =
        Math.floor(Date.parse(query.get("since")!) / POINT_MS[resolution]) * POINT_MS[resolution];
      await world.hold[resolution];
      const cursor = query.get("cursor");
      // A later page of a read is answered after the clock moved on.
      if (cursor !== null) vi.setSystemTime(Date.now() + HOUR_MS);
      const matching = world.points[resolution].filter(
        (point) =>
          Date.parse(point.at) >= since && (runnerId === null || point.runnerId === runnerId),
      );
      const start = cursor === null ? 0 : Number(cursor);
      const end = world.pageSize === undefined ? matching.length : start + world.pageSize;
      return {
        body: {
          items: matching.slice(start, end),
          ...(end < matching.length ? { nextCursor: String(end) } : {}),
        },
      };
    },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  await screen.findByRole("navigation", { name: "Fleet" });
  return { calls, ...app };
};

/**
 * Waits until the page holds the `runnerMetrics` subscription and the reads
 * the controller's first push started are done, so a test counts only the
 * reads of its own pushes.
 */
const settle = async (live: Awaited<ReturnType<typeof openApp>>["live"]): Promise<void> => {
  await waitFor(() => expect(live.readTopics()).toContain("runnerMetrics"));
  await live.waitForFirstPushes();
};

const pushMetrics = (
  live: Awaited<ReturnType<typeof openApp>>["live"],
  runners: readonly Runner[],
): void => {
  act(() =>
    live.pushInvalidation(
      "runnerMetrics",
      runners.map(({ id }) => id),
    ),
  );
};

/** Lets the app run what is waiting, so a read that should start has had its chance. */
const tick = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Waits for the app's pending reads to finish, after a tick that lets the reads a push causes begin. */
const waitForQuiet = async (
  context: Awaited<ReturnType<typeof openApp>>["context"],
): Promise<void> => {
  await tick();
  await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));
};

/** Returns the path data of the CPU graph's average line on the machine's page. */
const readCpuLine = (): string => {
  const graphs = screen
    .getByRole("region", { name: "Capacity" })
    .querySelectorAll<SVGSVGElement>("svg.machine-graph");
  return graphs[1]!.querySelector(".machine-graph-line")!.getAttribute("d")!;
};

const buildMachineWorld = (): World => ({
  runners: [ATLAS, FORGE],
  points: {
    fiveMinutes: [
      buildPoint(ATLAS, "2026-11-02T13:50:00.000Z"),
      buildPoint(ATLAS, "2026-11-02T13:55:00.000Z"),
      buildPoint(ATLAS, "2026-11-02T14:00:00.000Z", { minutes: 2 }),
      buildPoint(FORGE, "2026-11-02T14:00:00.000Z", { minutes: 2 }),
    ],
    hour: [],
  },
  hold: {},
});

describe("a machine's page", () => {
  it("reads its five-minute points of the last 24 hours as it opens, and the Fleet page's hour points for its Storage forecast", async () => {
    const { calls } = await openApp(`/fleet/${ATLAS.id}`, buildMachineWorld());

    // The range starts two points inside the controller's limit, on a point boundary,
    // and ends at the time of the read. The hour points are every machine's, as the
    // Fleet page reads them, not a 14-day read of this machine.
    expect(readMetricsCalls(calls)).toEqual([
      {
        resolution: "fiveMinutes",
        runnerId: ATLAS.id,
        since: "2026-11-01T14:10:00.000Z",
        until: "2026-11-02T14:02:00.000Z",
      },
      {
        resolution: "hour",
        runnerId: null,
        since: "2026-10-26T16:00:00.000Z",
        until: "2026-11-02T14:02:00.000Z",
      },
    ]);
    expect(readCpuLine().split(" ")).toHaveLength(3);
  });

  it("reads the hour points again only when the last read is an hour old", async () => {
    const world = buildMachineWorld();
    world.points.hour.push(buildPoint(ATLAS, "2026-11-02T14:00:00.000Z", { minutes: 60 }));
    const { calls, live, context } = await openApp(`/fleet/${ATLAS.id}`, world);
    await settle(live);
    expect(readHourCalls(calls)).toHaveLength(1);

    // A nudge within the hour reads the five-minute points and no hour points.
    pushMetrics(live, [ATLAS]);
    await waitForQuiet(context);
    expect(readHourCalls(calls)).toHaveLength(1);

    world.points.hour.push(buildPoint(ATLAS, "2026-11-02T15:00:00.000Z", { minutes: 3 }));
    vi.setSystemTime(new Date("2026-11-02T15:03:00.000Z"));
    pushMetrics(live, [ATLAS]);
    await waitFor(() => expect(readHourCalls(calls)).toHaveLength(2));
    expect(readHourCalls(calls)[1]).toEqual({
      resolution: "hour",
      runnerId: null,
      since: "2026-11-02T14:00:00.000Z",
      until: "2026-11-02T15:03:00.000Z",
    });
  });

  it("reads from the start of its newest point when a push names it, and draws the point that follows", async () => {
    const world = buildMachineWorld();
    const { calls, live, context } = await openApp(`/fleet/${ATLAS.id}`, world);
    await settle(live);
    const before = readFiveMinuteCalls(calls).length;
    const runnerReadsBefore = countRunnerReads(calls);

    world.points.fiveMinutes.splice(
      2,
      2,
      buildPoint(ATLAS, "2026-11-02T14:00:00.000Z", { cpuAveragePercent: 30 }),
      buildPoint(ATLAS, "2026-11-02T14:05:00.000Z", { cpuAveragePercent: 45 }),
      buildPoint(FORGE, "2026-11-02T14:00:00.000Z"),
    );
    vi.setSystemTime(new Date("2026-11-02T14:06:00.000Z"));
    pushMetrics(live, [ATLAS]);

    await waitFor(() => expect(readCpuLine().split(" ")).toHaveLength(4));
    await waitForQuiet(context);
    const reads = readFiveMinuteCalls(calls).slice(before);
    expect(reads).toEqual([
      {
        resolution: "fiveMinutes",
        runnerId: ATLAS.id,
        since: "2026-11-02T14:00:00.000Z",
        until: "2026-11-02T14:06:00.000Z",
      },
    ]);
    expect(countRunnerReads(calls)).toBe(runnerReadsBefore + 1);
  });

  it("gives every page of a read the same end, though the clock moves between pages", async () => {
    const world = buildMachineWorld();
    world.pageSize = 2;
    const { calls } = await openApp(`/fleet/${ATLAS.id}`, world);

    // Atlas's three five-minute points come in two pages. The second page is
    // answered an hour later, and still ends where the first did.
    const reads = readFiveMinuteCalls(calls);
    expect(reads).toHaveLength(2);
    expect(new Set(reads.map((read) => read.until))).toEqual(new Set(["2026-11-02T14:02:00.000Z"]));
    expect(readCpuLine().split(" ")).toHaveLength(3);
  });

  it("reads nothing when a push names another machine only", async () => {
    const { calls, live, context } = await openApp(`/fleet/${ATLAS.id}`, buildMachineWorld());
    await settle(live);
    // A read the page started late (its other sections load on their own) must not count as the push's.
    await waitForQuiet(context);
    const before = calls.length;

    pushMetrics(live, [FORGE]);
    await waitForQuiet(context);

    expect(calls).toHaveLength(before);
  });

  it("reads once more, not once per push, when pushes arrive while it reads", async () => {
    const world = buildMachineWorld();
    const { calls, live, context } = await openApp(`/fleet/${ATLAS.id}`, world);
    await settle(live);
    const before = readFiveMinuteCalls(calls).length;
    let release = () => {};
    world.hold.fiveMinutes = new Promise((resolve) => {
      release = resolve;
    });

    pushMetrics(live, [ATLAS]);
    await waitFor(() => expect(readFiveMinuteCalls(calls)).toHaveLength(before + 1));
    pushMetrics(live, [ATLAS]);
    pushMetrics(live, [ATLAS]);
    pushMetrics(live, [ATLAS]);
    await tick();
    expect(readFiveMinuteCalls(calls)).toHaveLength(before + 1);

    delete world.hold.fiveMinutes;
    release();
    await waitFor(() => expect(readFiveMinuteCalls(calls)).toHaveLength(before + 2));
    await waitForQuiet(context);
    expect(readFiveMinuteCalls(calls)).toHaveLength(before + 2);
  });

  it("reads nothing while the window is hidden, and catches up when it shows", async () => {
    const { calls, live, context } = await openApp(`/fleet/${ATLAS.id}`, buildMachineWorld());
    await settle(live);

    setVisibility("hidden");
    await waitFor(() => expect(live.readTopics()).not.toContain("runnerMetrics"));
    await waitForQuiet(context);
    const before = calls.length;
    await waitForQuiet(context);
    expect(calls).toHaveLength(before);

    const fiveMinuteReads = readFiveMinuteCalls(calls).length;
    setVisibility("visible");
    await waitFor(() => expect(readFiveMinuteCalls(calls)).toHaveLength(fiveMinuteReads + 1));
  });
});

describe("the Fleet page", () => {
  /** Hourly points of atlas for the last 3 days whose free space falls 1 GB an hour. */
  const buildFallingDiskPoints = (): RunnerMetricsPoint[] =>
    Array.from({ length: 73 }, (_, index) => 72 - index).map((hoursAgo) =>
      buildPoint(
        ATLAS,
        new Date(Date.parse("2026-11-02T14:00:00.000Z") - hoursAgo * HOUR_MS).toISOString(),
        { minutes: 60, diskFreeBytes: 100_000_000_000 + hoursAgo * 1_000_000_000 },
      ),
    );

  it("reads every machine's hour points of the last 7 days once as it opens, and forecasts the disk from them", async () => {
    const world: World = {
      runners: [ATLAS, FORGE],
      points: { fiveMinutes: [], hour: buildFallingDiskPoints() },
      hold: {},
    };
    const { calls, live, context } = await openApp("/fleet", world);
    await settle(live);

    pushMetrics(live, [ATLAS]);
    pushMetrics(live, []);
    await waitForQuiet(context);

    expect(readMetricsCalls(calls)).toEqual([
      {
        resolution: "hour",
        runnerId: null,
        since: "2026-10-26T16:00:00.000Z",
        until: "2026-11-02T14:02:00.000Z",
      },
    ]);
    expect(await screen.findByText("Disk reaches its limit in about 4 days")).toBeTruthy();
  });

  it("reads the hour points again only when the last read is an hour old", async () => {
    const world: World = {
      runners: [ATLAS, FORGE],
      points: { fiveMinutes: [], hour: buildFallingDiskPoints() },
      hold: {},
    };
    const { calls, live } = await openApp("/fleet", world);
    await settle(live);
    expect(readHourCalls(calls)).toHaveLength(1);

    world.points.hour.push(buildPoint(ATLAS, "2026-11-02T15:00:00.000Z", { minutes: 3 }));
    vi.setSystemTime(new Date("2026-11-02T15:03:00.000Z"));
    pushMetrics(live, [ATLAS]);
    await waitFor(() => expect(readHourCalls(calls)).toHaveLength(2));

    expect(readHourCalls(calls)[1]).toEqual({
      resolution: "hour",
      runnerId: null,
      since: "2026-11-02T14:00:00.000Z",
      until: "2026-11-02T15:03:00.000Z",
    });
  });

  it("reads the hour points once more when a push arrives during an hourly read, so no report waits another hour", async () => {
    const world: World = {
      runners: [ATLAS, FORGE],
      points: { fiveMinutes: [], hour: buildFallingDiskPoints() },
      hold: {},
    };
    const { calls, live, context } = await openApp("/fleet", world);
    await settle(live);
    let release = () => {};
    world.hold.hour = new Promise((resolve) => {
      release = resolve;
    });

    vi.setSystemTime(new Date("2026-11-02T15:03:00.000Z"));
    pushMetrics(live, [ATLAS]);
    await waitFor(() => expect(readHourCalls(calls)).toHaveLength(2));
    pushMetrics(live, [ATLAS]);
    pushMetrics(live, [ATLAS]);
    await tick();
    expect(readHourCalls(calls)).toHaveLength(2);

    delete world.hold.hour;
    release();
    await waitFor(() => expect(readHourCalls(calls)).toHaveLength(3));
    await waitForQuiet(context);
    expect(readHourCalls(calls)).toHaveLength(3);
  });

  it("reads the runners again on a push, for the latest metrics on the cards", async () => {
    const world: World = {
      runners: [ATLAS, FORGE],
      points: { fiveMinutes: [], hour: [] },
      hold: {},
    };
    const { calls, live, context } = await openApp("/fleet", world);
    await settle(live);
    const before = countRunnerReads(calls);

    pushMetrics(live, [ATLAS]);

    await waitFor(() => expect(countRunnerReads(calls)).toBe(before + 1));
    await waitForQuiet(context);
    expect(countRunnerReads(calls)).toBe(before + 1);
  });

  it("keeps the card of a machine that did not change as it was when another machine's metrics arrive", async () => {
    const world: World = {
      runners: [ATLAS, FORGE],
      points: { fiveMinutes: [], hour: [] },
      hold: {},
    };
    const { live, context } = await openApp("/fleet", world);
    await settle(live);
    const atlasDrawn = drawnMachines.get(ATLAS.id)!.length;
    const forgeMachine = drawnMachines.get(FORGE.id)!.at(-1);

    world.runners = [
      { ...ATLAS, metrics: { diskFreeBytes: 90_000_000_000, availableMemoryBytes: 8 * GIB } },
      FORGE,
    ];
    pushMetrics(live, [ATLAS]);
    await waitFor(() => expect(drawnMachines.get(ATLAS.id)!.length).toBeGreaterThan(atlasDrawn));
    await waitForQuiet(context);

    expect(drawnMachines.get(FORGE.id)!.at(-1)).toBe(forgeMachine);
    expect(drawnMachines.get(ATLAS.id)!.at(-1)).not.toBe(
      drawnMachines.get(ATLAS.id)![atlasDrawn - 1],
    );
  });
});
