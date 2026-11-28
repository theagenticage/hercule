import { describe, expect, it } from "vitest";
import {
  RUNNER_METRICS_POINT_MS,
  type RunnerMetricsPoint,
  type RunnerMetricsResolution,
} from "@hercule/contract";
import type { HerculeClient } from "../client";
import {
  buildMachineFiveMinuteScope,
  EMPTY_RUNNER_METRICS_HISTORY,
  FLEET_HOUR_METRICS_SCOPE,
  readRunnerMetricsHistory,
  type RunnerMetricsHistory,
  type RunnerMetricsScope,
} from "./metrics-history";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.parse("2026-11-03T09:00:00.000Z");

const ATLAS = "01a06d02-0000-7000-8000-00000000000a";
const BOREAS = "01a06d02-0000-7000-8000-00000000000b";

/** Every runner's five-minute points over a day: the scope of a history whose runner does not matter to a test. */
const EVERY_RUNNER_SCOPE: RunnerMetricsScope = {
  resolution: "fiveMinutes",
  runnerId: null,
  rangeMs: DAY_MS,
};

/** A point of `runnerId` starting `minutes` after 09:00, with the free disk space telling points apart. */
const buildPoint = (
  runnerId: string,
  minutes: number,
  diskFreeBytes = 100,
): RunnerMetricsPoint => ({
  runnerId,
  at: new Date(T0 + minutes * MINUTE_MS).toISOString(),
  minutes: 5,
  diskFreeBytes,
  availableMemoryBytes: 1,
  availableMemoryLowestBytes: 1,
  cpuAveragePercent: null,
  cpuPeakPercent: null,
  sessionsRunning: 0,
  sessionsQueued: 0,
});

const buildHistory = (
  points: RunnerMetricsPoint[],
  readAt = T0 + 10 * MINUTE_MS,
): RunnerMetricsHistory => ({
  points,
  readAt,
});

const describePoints = (history: RunnerMetricsHistory): string[] =>
  history.points.map(
    (point) =>
      `${point.runnerId.slice(-1)}@${(Date.parse(point.at) - T0) / MINUTE_MS}:${point.diskFreeBytes}`,
  );

/** One `runnerMetrics.query` request, as the controller received it. */
interface Request {
  readonly runnerId?: string;
  readonly since: string;
  readonly until: string;
  readonly resolution: RunnerMetricsResolution;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * A client whose controller holds `stored` (sorted by runner, then oldest
 * first). It answers like the real one: the points from the start of the point
 * that holds `since` up to `until`, of the runner when one is named, in pages
 * of `pageSize` points.
 */
const buildFakeClient = (stored: readonly RunnerMetricsPoint[], pageSize = Infinity) => {
  const requests: Request[] = [];
  const client = {
    runnerMetrics: {
      query: ({ query }: { query: Request }) => {
        requests.push(query);
        const pointMs = RUNNER_METRICS_POINT_MS[query.resolution];
        const sinceMs = Math.floor(Date.parse(query.since) / pointMs) * pointMs;
        const matching = stored.filter(
          (point) =>
            Date.parse(point.at) >= sinceMs &&
            point.at < query.until &&
            (query.runnerId === undefined || point.runnerId === query.runnerId),
        );
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const end = Math.min(start + pageSize, matching.length);
        return Promise.resolve({
          items: matching.slice(start, end),
          ...(end < matching.length ? { nextCursor: String(end) } : {}),
        });
      },
    },
  } as unknown as HerculeClient;
  return { client, requests };
};

describe("readRunnerMetricsHistory", () => {
  const now = T0 + 12 * MINUTE_MS;

  it("replaces the point that was still filling and appends the new ones", async () => {
    const held = buildHistory([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5, 100)]);
    const { client, requests } = buildFakeClient([
      buildPoint(ATLAS, 0),
      buildPoint(ATLAS, 5, 90),
      buildPoint(ATLAS, 10, 80),
    ]);

    const read = await readRunnerMetricsHistory(client, EVERY_RUNNER_SCOPE, held, now);

    expect(requests.map((request) => request.since)).toEqual([
      new Date(T0 + 5 * MINUTE_MS).toISOString(),
    ]);
    expect(describePoints(read)).toEqual(["a@0:100", "a@5:90", "a@10:80"]);
    expect(read.readAt).toBe(now);
  });

  it("keeps the sort by runner, then oldest first, with several runners", async () => {
    const held = buildHistory([
      buildPoint(ATLAS, 0),
      buildPoint(ATLAS, 5, 100),
      buildPoint(BOREAS, 0),
      buildPoint(BOREAS, 5, 100),
    ]);
    const { client } = buildFakeClient([
      buildPoint(ATLAS, 5, 90),
      buildPoint(ATLAS, 10, 80),
      buildPoint(BOREAS, 5, 90),
      buildPoint(BOREAS, 10, 80),
    ]);

    const read = await readRunnerMetricsHistory(client, EVERY_RUNNER_SCOPE, held, now);

    expect(describePoints(read)).toEqual([
      "a@0:100",
      "a@5:90",
      "a@10:80",
      "b@0:100",
      "b@5:90",
      "b@10:80",
    ]);
  });

  it("reads from the newest start across all runners", async () => {
    const held = buildHistory([
      buildPoint(ATLAS, 0),
      buildPoint(ATLAS, 10),
      buildPoint(BOREAS, 0),
      buildPoint(BOREAS, 5),
    ]);
    const { client, requests } = buildFakeClient([]);

    await readRunnerMetricsHistory(client, EVERY_RUNNER_SCOPE, held, now);

    expect(requests[0]!.since).toBe(new Date(T0 + 10 * MINUTE_MS).toISOString());
  });

  it("adds the points of a runner that had none yet", async () => {
    const held = buildHistory([buildPoint(BOREAS, 0), buildPoint(BOREAS, 5)]);
    const { client } = buildFakeClient([buildPoint(ATLAS, 5), buildPoint(BOREAS, 5, 90)]);

    const read = await readRunnerMetricsHistory(
      client,
      EVERY_RUNNER_SCOPE,
      held,
      T0 + 6 * MINUTE_MS,
    );

    expect(describePoints(read)).toEqual(["a@5:100", "b@0:100", "b@5:90"]);
  });

  it("drops points older than the range", async () => {
    const held = buildHistory([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5)]);
    const { client } = buildFakeClient([buildPoint(ATLAS, 5), buildPoint(ATLAS, 10)]);
    const tenMinutes = { ...EVERY_RUNNER_SCOPE, rangeMs: 10 * MINUTE_MS };

    // The range ends at 09:12 and reaches 10 minutes back, so 09:00 is out and 09:05 stays.
    const read = await readRunnerMetricsHistory(client, tenMinutes, held, now);

    expect(describePoints(read)).toEqual(["a@5:100", "a@10:100"]);
  });

  it("returns a new history when an empty read still drops a point", async () => {
    const held = buildHistory([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5)]);
    const { client } = buildFakeClient([]);
    const tenMinutes = { ...EVERY_RUNNER_SCOPE, rangeMs: 10 * MINUTE_MS };

    const read = await readRunnerMetricsHistory(client, tenMinutes, held, now);

    expect(describePoints(read)).toEqual(["a@5:100"]);
  });

  it("returns the held history itself when the read is empty and nothing falls out", async () => {
    // The newest held point is older than the start of the range, so the
    // read asks for nothing the history holds, and finds nothing.
    const held = buildHistory([buildPoint(ATLAS, -5)]);
    const { client } = buildFakeClient([]);
    const twentyMinutes = { ...EVERY_RUNNER_SCOPE, rangeMs: 20 * MINUTE_MS };

    const read = await readRunnerMetricsHistory(client, twentyMinutes, held, now);

    expect(read).toBe(held);
  });

  it("builds a first history from an empty one", async () => {
    const { client } = buildFakeClient([buildPoint(ATLAS, 0), buildPoint(ATLAS, 5)]);

    const read = await readRunnerMetricsHistory(
      client,
      EVERY_RUNNER_SCOPE,
      EMPTY_RUNNER_METRICS_HISTORY,
      T0 + HOUR_MS,
    );

    expect(describePoints(read)).toEqual(["a@0:100", "a@5:100"]);
  });

  it("gives every page of a read the same end, the time of the read", async () => {
    const stored = Array.from({ length: 5 }, (_, index) => buildPoint(ATLAS, index * 5));
    const { client, requests } = buildFakeClient(stored, 2);

    const read = await readRunnerMetricsHistory(
      client,
      EVERY_RUNNER_SCOPE,
      EMPTY_RUNNER_METRICS_HISTORY,
      T0 + 30 * MINUTE_MS,
    );

    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.until))).toEqual(
      new Set([new Date(T0 + 30 * MINUTE_MS).toISOString()]),
    );
    expect(read.points).toHaveLength(5);
  });

  describe("the start of a first read", () => {
    const readFirst = async (scope: RunnerMetricsScope, at: number): Promise<Request> => {
      const { client, requests } = buildFakeClient([]);
      await readRunnerMetricsHistory(client, scope, EMPTY_RUNNER_METRICS_HISTORY, at);
      return requests[0]!;
    };

    it("is two points after the range's start, on a point boundary", async () => {
      const at = T0 + 2 * MINUTE_MS;
      expect((await readFirst(buildMachineFiveMinuteScope(ATLAS), at)).since).toBe(
        new Date(T0 - DAY_MS + 10 * MINUTE_MS).toISOString(),
      );
      expect((await readFirst(FLEET_HOUR_METRICS_SCOPE, at)).since).toBe(
        new Date(T0 - 7 * DAY_MS + 2 * HOUR_MS).toISOString(),
      );
    });

    it("keeps the margin under the controller's range limit", async () => {
      for (const offset of [0, 1, MINUTE_MS, 4 * MINUTE_MS + 59_999]) {
        const at = T0 + offset;
        const request = await readFirst(buildMachineFiveMinuteScope(ATLAS), at);
        // The controller measures the span from `since` to `until`.
        expect(Date.parse(request.until) - Date.parse(request.since)).toBeLessThan(DAY_MS);
      }
    });

    it("is the start of the range again when the newest held point is older than the range", async () => {
      const held = buildHistory([buildPoint(ATLAS, 0)]);
      const at = T0 + 30 * HOUR_MS;
      const { client, requests } = buildFakeClient([]);

      await readRunnerMetricsHistory(client, EVERY_RUNNER_SCOPE, held, at);

      expect(requests[0]!.since).toBe((await readFirst(EVERY_RUNNER_SCOPE, at)).since);
    });
  });

  it("names the runner of a machine's scope, and no runner for the Fleet page's", async () => {
    const machine = buildFakeClient([]);
    const fleet = buildFakeClient([]);

    await readRunnerMetricsHistory(
      machine.client,
      buildMachineFiveMinuteScope(ATLAS),
      EMPTY_RUNNER_METRICS_HISTORY,
      now,
    );
    await readRunnerMetricsHistory(
      fleet.client,
      FLEET_HOUR_METRICS_SCOPE,
      EMPTY_RUNNER_METRICS_HISTORY,
      now,
    );

    expect(machine.requests[0]).toMatchObject({
      runnerId: ATLAS,
      resolution: "fiveMinutes",
      limit: 500,
    });
    expect(fleet.requests[0]).toMatchObject({ resolution: "hour", limit: 500 });
    expect(fleet.requests[0]).not.toHaveProperty("runnerId");
  });
});
