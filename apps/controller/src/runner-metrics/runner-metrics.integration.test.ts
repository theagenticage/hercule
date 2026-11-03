/**
 * Tests `runnerMetrics.query` over a real HTTP server: what survives the trip
 * through a URL query (the resolution, the span, the limit and the cursor),
 * the points a client receives, and the refusals it receives for a span it may
 * not read.
 *
 * Rows are written straight into `runner_metrics`, because the report that
 * writes them is a runner's frame and is tested with the runner socket.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { RunnerMetricsPoint } from "@hercule/contract";
import { uuidFromString, withTransaction } from "../db";
import type { ServerHarness } from "../http/testing";
import { completeSetup, get, readErrorBody, withServer } from "../http/testing";

interface PointsPage {
  readonly items: ReadonlyArray<RunnerMetricsPoint>;
  readonly nextCursor?: string;
}

const START = Date.parse("2026-11-03T10:00:00.000Z");
const MINUTE = 60_000;

const iso = (minutes: number): string => new Date(START + minutes * MINUTE).toISOString();

/** Writes one row for each of the minutes, with a free disk that tells them apart. */
const writeRows = (
  harness: ServerHarness,
  runnerId: string,
  minutes: ReadonlyArray<number>,
): Promise<void> =>
  Effect.runPromise(
    Effect.orDie(
      withTransaction(
        harness.sql,
        Effect.forEach(
          minutes,
          (minute) =>
            harness.sql`INSERT INTO runner_metrics
                        (runner_id, minute, disk_free_bytes, available_memory_bytes,
                         cpu_average_percent, cpu_peak_percent, sessions_running, sessions_queued)
                      VALUES (${uuidFromString(runnerId)}, ${START + minute * MINUTE},
                              ${1000 + minute}, 2000, ${minute}, ${minute + 1}, 1, 0)`,
        ),
      ),
    ).pipe(Effect.asVoid),
  );

const query = (
  base: string,
  token: string,
  parameters: Record<string, string>,
): Promise<Response> =>
  get(base, `/api/v1/runner-metrics?${new URLSearchParams(parameters).toString()}`, token);

describe("runnerMetrics.query over HTTP", () => {
  it("answers the points of one runner, and pages them with the cursor it hands back", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });
      await writeRows(harness, runner.id, [0, 1, 2, 5, 6, 10]);
      const parameters = {
        runnerId: runner.id,
        since: iso(0),
        until: iso(60),
        resolution: "fiveMinutes",
        limit: "2",
      };

      const first = await query(harness.base, token, parameters);
      expect(first.status).toBe(200);
      const firstPage = (await first.json()) as PointsPage;
      expect(firstPage.items).toEqual([
        {
          runnerId: runner.id,
          at: iso(0),
          minutes: 3,
          diskFreeBytes: 1001,
          availableMemoryBytes: 2000,
          availableMemoryLowestBytes: 2000,
          cpuAveragePercent: 1,
          cpuPeakPercent: 3,
          sessionsRunning: 1,
          sessionsQueued: 0,
        },
        expect.objectContaining({ at: iso(5), minutes: 2 }),
      ]);

      const second = await query(harness.base, token, {
        ...parameters,
        cursor: firstPage.nextCursor!,
      });
      expect(second.status).toBe(200);
      const secondPage = (await second.json()) as PointsPage;
      expect(secondPage.items.map((point) => [point.at, point.minutes])).toEqual([[iso(10), 1]]);
      expect(secondPage.nextCursor).toBeUndefined();
    });
  });

  it("answers every runner's points when no runner is named", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const first = await harness.insertRunner({ name: "iris" });
      const second = await harness.insertRunner({ name: "atlas" });
      await writeRows(harness, first.id, [0]);
      await writeRows(harness, second.id, [0]);

      const response = await query(harness.base, token, {
        since: iso(0),
        until: iso(60),
        resolution: "hour",
      });

      expect(response.status).toBe(200);
      const page = (await response.json()) as PointsPage;
      expect(page.items.map((point) => point.runnerId)).toEqual([first.id, second.id].toSorted());
    });
  });

  it("reads a time written with an offset or without milliseconds as the UTC time it names", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });
      await writeRows(harness, runner.id, [0, 7]);

      const response = await query(harness.base, token, {
        since: "2026-11-03T12:00:00+02:00",
        until: "2026-11-03T10:30:00Z",
        resolution: "fiveMinutes",
      });

      expect(response.status).toBe(200);
      const page = (await response.json()) as PointsPage;
      expect(page.items.map((point) => point.at)).toEqual([iso(0), iso(5)]);
    });
  });

  it("refuses a request without a span or a resolution as a validation error", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      for (const parameters of [
        { resolution: "hour" },
        { since: iso(0) },
        { since: iso(0), resolution: "minute" },
        { since: "yesterday", resolution: "hour" },
        { since: "2026-02-30T10:00:00Z", resolution: "hour" },
        { since: "2026-11-03T10:00:00", resolution: "hour" },
      ]) {
        const response = await query(base, token, parameters);
        expect(response.status).toBe(400);
        expect((await readErrorBody(response)).code).toBe("validation");
      }
    });
  });

  it("refuses a span that is too long, with a message that says what to do", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await query(base, token, {
        since: iso(0),
        until: iso(25 * 60),
        resolution: "fiveMinutes",
      });

      expect(response.status).toBe(400);
      const body = await readErrorBody(response);
      expect(body.code).toBe("validation");
      expect(body.issues).toEqual([["since"]]);
      expect(body.text).toContain("five-minute points cover at most 24 hours");
    });
  });

  it("is refused to a caller with no credential", async () => {
    await withServer(async ({ base }) => {
      const response = await query(base, "", {
        since: iso(0),
        until: iso(60),
        resolution: "hour",
      });
      expect(response.status).toBe(401);
    });
  });
});
