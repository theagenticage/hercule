/**
 * Tests for `RunnerMetricsService` called in process: what a report writes,
 * what the prune deletes, how a query turns minutes into points, and the
 * rules it refuses a span by.
 *
 * The grant check is tested here because no credential a request can send is
 * missing `infra.read` (see the runners service test). The paths over HTTP
 * are in `runner-metrics.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Clock, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { RunnerMetrics, RunnerMetricsQuery } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { nowIso, withTransaction } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { runnerRepository } from "../runners";
import { Settings, SettingsLayer } from "../settings";
import { RunnerMetricsService, RunnerMetricsServiceLayer } from "./index";

const layer = RunnerMetricsServiceLayer.pipe(
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(TestDatabase),
);

type Provided = RunnerMetricsService | Settings | SqlClient.SqlClient;

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-1111-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-2222-7000-8000-000000000000", tokenHash: "hash" },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A UTC hour boundary two days ago, so the offsets below fall on known
 * five-minute and hour boundaries. It is in the past because a query never
 * reads beyond now.
 */
const START = Math.floor((Date.now() - 2 * DAY) / HOUR) * HOUR;

/** The instant `minutes` after `START`, as the ISO text a report is recorded at. */
const instant = (minutes: number, extraMs = 0): string =>
  new Date(START + minutes * MINUTE + extraMs).toISOString();

/** Builds a clock that stands at `millis`, for a query that must be answered at a known time. */
const buildClockAt = (millis: number): Clock.Clock => {
  const readNanos = () => BigInt(millis) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: readNanos,
    currentTimeNanos: Effect.sync(readNanos),
    monotonicTimeNanosUnsafe: readNanos,
    monotonicTimeNanos: Effect.sync(readNanos),
    sleep: () => Effect.void,
  };
};

const GIB = 1024 ** 3;

const report = (
  diskFreeGib: number,
  memoryGib: number,
  cpu?: { readonly average: number; readonly peak: number } | null,
): RunnerMetrics => ({
  diskFreeBytes: diskFreeGib * GIB,
  availableMemoryBytes: memoryGib * GIB,
  ...(cpu === undefined
    ? {}
    : { cpu: cpu === null ? null : { averagePercent: cpu.average, peakPercent: cpu.peak } }),
});

const runAsUser = <A, E>(effect: Effect.Effect<A, E, Provided>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer), Effect.orDie),
  );

const insertRunner = (name: string): Effect.Effect<string, never, Provided> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runners = yield* runnerRepository;
    const at = yield* nowIso;
    const runner = yield* withTransaction(
      sql,
      runners.insert({
        name,
        connectivity: "online",
        lifecycle: "active",
        reserved: false,
        labels: [],
        credentialHash: `hash-${name}`,
        at,
      }),
    );
    return runner.id;
  }).pipe(Effect.orDie);

/** Records a report in its own transaction, as the report handler does. */
const record = (
  runnerId: string,
  metrics: RunnerMetrics,
  at: string,
): Effect.Effect<void, never, Provided> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* RunnerMetricsService;
    yield* withTransaction(sql, service.record(runnerId, metrics, at));
  }).pipe(Effect.orDie);

/** Inserts a session of the runner in a status; a test needs only the runner and the status. */
const insertSession = (
  runnerId: string,
  status: "queued" | "starting" | "idle" | "busy" | "exited",
): Effect.Effect<void, never, Provided> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = crypto.randomUUID().replaceAll("-", "");
    yield* withTransaction(
      sql,
      sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                requested_access_mode, access_mode, spec, title, status,
                                created_at, last_activity_at, token_hash)
          VALUES (unhex(${id}), unhex(${id}), unhex(${id}), unhex(replace(${runnerId}, '-', '')),
                  'auto', 'auto', '{}', 'a session', ${status},
                  '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z',
                  ${status === "queued" || status === "exited" ? null : `hash-${id}`})`,
    );
  }).pipe(Effect.orDie);

interface RawRow {
  readonly minute: number;
  readonly disk_free_bytes: number;
  readonly available_memory_bytes: number;
  readonly cpu_average_percent: number | null;
  readonly cpu_peak_percent: number | null;
  readonly sessions_running: number;
  readonly sessions_queued: number;
}

/** Reads the stored rows of a runner, oldest first. */
const readRows = (runnerId: string): Effect.Effect<ReadonlyArray<RawRow>, never, Provided> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<RawRow>`
      SELECT minute, disk_free_bytes, available_memory_bytes, cpu_average_percent,
             cpu_peak_percent, sessions_running, sessions_queued
      FROM runner_metrics WHERE runner_id = unhex(replace(${runnerId}, '-', '')) ORDER BY minute`;
  }).pipe(Effect.orDie);

const query = (input: Partial<RunnerMetricsQuery> & Pick<RunnerMetricsQuery, "resolution">) =>
  Effect.gen(function* () {
    const service = yield* RunnerMetricsService;
    return yield* service.query({
      since: instant(0),
      until: instant(60),
      ...input,
    });
  });

describe("recording a report", () => {
  it("writes one row for the minute, and a second report in that minute replaces the first", async () => {
    const rows = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        yield* record(runner, report(50, 8, { average: 10, peak: 20 }), instant(3, 1_000));
        yield* record(runner, report(40, 6, { average: 30, peak: 70 }), instant(3, 59_999));
        return yield* readRows(runner);
      }),
    );

    expect(rows).toEqual([
      {
        minute: START + 3 * MINUTE,
        disk_free_bytes: 40 * GIB,
        available_memory_bytes: 6 * GIB,
        cpu_average_percent: 30,
        cpu_peak_percent: 70,
        sessions_running: 0,
        sessions_queued: 0,
      },
    ]);
  });

  it("leaves a minute with no report without a row", async () => {
    const rows = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        yield* record(runner, report(50, 8), instant(1));
        yield* record(runner, report(50, 8), instant(4));
        return yield* readRows(runner);
      }),
    );

    expect(rows.map((row) => row.minute)).toEqual([START + MINUTE, START + 4 * MINUTE]);
  });

  it("stores no CPU when the report has a null cpu or none", async () => {
    const rows = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        yield* record(runner, report(50, 8, null), instant(1));
        yield* record(runner, report(50, 8), instant(2));
        return yield* readRows(runner);
      }),
    );

    expect(rows.map((row) => [row.cpu_average_percent, row.cpu_peak_percent])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("counts the runner's own sessions: running ones take a slot, queued ones wait, exited ones are not counted", async () => {
    const rows = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        const other = yield* insertRunner("atlas");
        for (const status of ["starting", "idle", "busy", "busy", "queued", "exited"] as const) {
          yield* insertSession(runner, status);
        }
        yield* insertSession(other, "busy");
        yield* record(runner, report(50, 8), instant(0));
        return yield* readRows(runner);
      }),
    );

    expect(rows.map((row) => [row.sessions_running, row.sessions_queued])).toEqual([[4, 1]]);
  });

  it("announces the runner on the runnerMetrics topic once the transaction commits", async () => {
    const recorder = buildAnnouncementRecorder();
    const runnerId = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        yield* record(runner, report(50, 8), instant(0));
        return runner;
      }).pipe(Effect.provide(layer), Effect.provide(recorder.listener), Effect.orDie),
    );

    expect(recorder.announced).toEqual([
      { _tag: "record", topic: "runnerMetrics", id: runnerId, kind: "updated" },
    ]);
  });
});

describe("pruning", () => {
  /** Records one report per age, in days before `NOW`, for a runner. */
  const NOW = instant(0);
  const daysAgo = (days: number): string => new Date(START - days * DAY).toISOString();

  const remainingAges = (runner: string): Effect.Effect<ReadonlyArray<number>, never, Provided> =>
    Effect.map(readRows(runner), (rows) => rows.map((row) => (START - row.minute) / DAY));

  it("deletes the rows older than 14 days by default, and keeps the rest", async () => {
    const ages = await runAsUser(
      Effect.gen(function* () {
        const service = yield* RunnerMetricsService;
        const runner = yield* insertRunner("iris");
        for (const days of [20, 14.5, 14, 13.5, 1, 0]) {
          yield* record(runner, report(50, 8), daysAgo(days));
        }
        yield* service.prune(NOW);
        return yield* remainingAges(runner);
      }),
    );

    // A row exactly 14 days old is kept: only older rows are deleted.
    expect(ages).toEqual([14, 13.5, 1, 0]);
  });

  it("follows the retention.runnerMetrics setting, for every runner", async () => {
    const ages = await runAsUser(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* RunnerMetricsService;
        const settings = yield* Settings;
        yield* withTransaction(sql, settings.set("retention.runnerMetrics", 2));
        const first = yield* insertRunner("iris");
        const second = yield* insertRunner("atlas");
        for (const runner of [first, second]) {
          for (const days of [3, 1]) yield* record(runner, report(50, 8), daysAgo(days));
        }
        yield* service.prune(NOW);
        return [yield* remainingAges(first), yield* remainingAges(second)];
      }),
    );

    expect(ages).toEqual([[1], [1]]);
  });
});

describe("a query", () => {
  it("turns the minutes of a five-minute span into one point with their means, lowest, highest and counts", async () => {
    const page = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        yield* insertSession(runner, "busy");
        yield* record(runner, report(50, 8, { average: 10, peak: 20 }), instant(0));
        yield* insertSession(runner, "busy");
        yield* insertSession(runner, "queued");
        yield* record(runner, report(40, 4, { average: 20, peak: 90 }), instant(1));
        // The third minute has no CPU, so the CPU values come from the other two.
        yield* record(runner, report(30, 6), instant(2));
        // The next point has one minute and no CPU at all.
        yield* record(runner, report(20, 2, null), instant(5));
        return { runner, page: yield* query({ resolution: "fiveMinutes" }) };
      }),
    );

    expect(page.page).toEqual({
      items: [
        {
          runnerId: page.runner,
          at: instant(0),
          minutes: 3,
          diskFreeBytes: 40 * GIB,
          availableMemoryBytes: 6 * GIB,
          availableMemoryLowestBytes: 4 * GIB,
          cpuAveragePercent: 15,
          cpuPeakPercent: 90,
          sessionsRunning: 2,
          sessionsQueued: 1,
        },
        {
          runnerId: page.runner,
          at: instant(5),
          minutes: 1,
          diskFreeBytes: 20 * GIB,
          availableMemoryBytes: 2 * GIB,
          availableMemoryLowestBytes: 2 * GIB,
          cpuAveragePercent: null,
          cpuPeakPercent: null,
          sessionsRunning: 2,
          sessionsQueued: 1,
        },
      ],
    });
  });

  it("rounds a mean of bytes to a whole byte and a mean of CPU to one decimal", async () => {
    const [point] = (
      await runAsUser(
        Effect.gen(function* () {
          const runner = yield* insertRunner("iris");
          yield* record(runner, { diskFreeBytes: 1, availableMemoryBytes: 10 }, instant(0));
          yield* record(
            runner,
            {
              diskFreeBytes: 2,
              availableMemoryBytes: 11,
              cpu: { averagePercent: 10.25, peakPercent: 11 },
            },
            instant(1),
          );
          yield* record(
            runner,
            {
              diskFreeBytes: 2,
              availableMemoryBytes: 11,
              cpu: { averagePercent: 10, peakPercent: 11 },
            },
            instant(2),
          );
          return yield* query({ resolution: "fiveMinutes" });
        }),
      )
    ).items;

    // Disk: (1 + 2 + 2) / 3 = 1.67. Memory: (10 + 11 + 11) / 3 = 10.67. CPU: (10.25 + 10) / 2.
    expect(point).toMatchObject({
      diskFreeBytes: 2,
      availableMemoryBytes: 11,
      cpuAveragePercent: 10.1,
    });
  });

  it("starts at the beginning of the point that `since` falls in, so every point is whole", async () => {
    const points = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        for (const minute of [0, 3, 7]) yield* record(runner, report(50, 8), instant(minute));
        const page = yield* query({ resolution: "fiveMinutes", since: instant(4) });
        return page.items.map((point) => [point.at, point.minutes]);
      }),
    );

    expect(points).toEqual([
      [instant(0), 2],
      [instant(5), 1],
    ]);
  });

  it("leaves out the minutes at `until` and after", async () => {
    const points = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        for (const minute of [0, 6, 7]) yield* record(runner, report(50, 8), instant(minute));
        const page = yield* query({ resolution: "fiveMinutes", until: instant(7) });
        return page.items.map((point) => [point.at, point.minutes]);
      }),
    );

    expect(points).toEqual([
      [instant(0), 1],
      [instant(5), 1],
    ]);
  });

  it("makes hour points on whole UTC hours, and shows a gap as fewer minutes", async () => {
    const points = await runAsUser(
      Effect.gen(function* () {
        const runner = yield* insertRunner("iris");
        for (const minute of [0, 30, 59, 61]) {
          yield* record(runner, report(50, 8), instant(minute));
        }
        const page = yield* query({
          resolution: "hour",
          since: instant(25),
          until: instant(180),
        });
        return page.items.map((point) => [point.at, point.minutes]);
      }),
    );

    expect(points).toEqual([
      [instant(0), 3],
      [instant(60), 1],
    ]);
  });

  it("answers one runner, or every runner ordered by runner", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        const first = yield* insertRunner("iris");
        const second = yield* insertRunner("atlas");
        yield* record(first, report(50, 8), instant(0));
        yield* record(second, report(50, 8), instant(0));
        yield* record(second, report(50, 8), instant(10));
        const one = yield* query({ resolution: "fiveMinutes", runnerId: second });
        const all = yield* query({ resolution: "fiveMinutes" });
        return {
          first,
          second,
          one: one.items.map((point) => [point.runnerId, point.at]),
          all: all.items.map((point) => [point.runnerId, point.at]),
        };
      }),
    );

    expect(result.one).toEqual([
      [result.second, instant(0)],
      [result.second, instant(10)],
    ]);
    const pointsOf = (runnerId: string) =>
      runnerId === result.first
        ? [[runnerId, instant(0)]]
        : [
            [runnerId, instant(0)],
            [runnerId, instant(10)],
          ];
    expect(result.all).toEqual([result.first, result.second].toSorted().flatMap(pointsOf));
  });

  it("pages across runners without splitting a point", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        const service = yield* RunnerMetricsService;
        const first = yield* insertRunner("iris");
        const second = yield* insertRunner("atlas");
        for (let minute = 0; minute < 15; minute++) {
          yield* record(first, report(50, 8), instant(minute));
        }
        for (let minute = 0; minute < 10; minute++) {
          yield* record(second, report(50, 8), instant(minute));
        }
        const pages: Array<ReadonlyArray<readonly [string, string, number]>> = [];
        let cursor: string | undefined;
        do {
          const page = yield* service.query({
            since: instant(0),
            until: instant(60),
            resolution: "fiveMinutes",
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          pages.push(page.items.map((point) => [point.runnerId, point.at, point.minutes] as const));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return { pages, first, second };
      }),
    );

    const pointsOf = (runnerId: string) =>
      Array.from({ length: runnerId === result.first ? 3 : 2 }, (_, index) => [
        runnerId,
        instant(index * 5),
        5,
      ]);
    const expected = [result.first, result.second].toSorted().flatMap(pointsOf);
    expect(result.pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(result.pages.flat()).toEqual(expected);
  });
});

describe("a read of several pages", () => {
  it("ends every page at the instant the first page was answered, even when until is ahead of the clock", async () => {
    const found = await runAsUser(
      Effect.gen(function* () {
        const service = yield* RunnerMetricsService;
        const runner = yield* insertRunner("iris");
        yield* record(runner, report(50, 8), instant(0));
        yield* record(runner, report(50, 8), instant(20));
        // A client whose clock is ahead asks for an `until` after the time the
        // controller answers.
        const span = {
          runnerId: runner,
          since: instant(0),
          until: instant(180),
          resolution: "fiveMinutes",
        } as const;
        const first = yield* Effect.provideService(
          service.query({ ...span, limit: 1 }),
          Clock.Clock,
          buildClockAt(START + 60 * MINUTE),
        );
        // A report arrives after the first page, for a minute that is before
        // `until` but after the time the first page was answered.
        yield* record(runner, report(50, 8), instant(90));
        const later = yield* Effect.provideService(
          // The limit is large enough that the page's range reaches the new row.
          service.query({ ...span, limit: 30, cursor: first.nextCursor! }),
          Clock.Clock,
          buildClockAt(START + 4 * HOUR),
        );
        return { first: first.items, later: later.items, hadCursor: first.nextCursor };
      }),
    );

    expect(found.hadCursor).toBeDefined();
    expect(found.first.map((point) => point.at)).toEqual([instant(0)]);
    expect(found.later.map((point) => point.at)).toEqual([instant(20)]);
  });

  it("fills every page but the last, across runners that have few points or none", async () => {
    const found = await runAsUser(
      Effect.gen(function* () {
        const service = yield* RunnerMetricsService;
        const created = yield* Effect.forEach(["a", "b", "c", "d", "e"], insertRunner);
        const runners = created.toSorted();
        // The runners that sort second and fourth have rows. The others have none.
        for (const minute of [0, 5, 10]) yield* record(runners[1]!, report(50, 8), instant(minute));
        for (const minute of [0, 5]) yield* record(runners[3]!, report(50, 8), instant(minute));
        const pages: Array<ReadonlyArray<string>> = [];
        const cursors: Array<string | undefined> = [];
        let cursor: string | undefined;
        do {
          const page = yield* service.query({
            since: instant(0),
            until: instant(60),
            resolution: "fiveMinutes",
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          pages.push(page.items.map((point) => `${point.runnerId} ${point.at}`));
          cursors.push(page.nextCursor);
          cursor = page.nextCursor;
        } while (cursor !== undefined && pages.length < 20);
        return { pages, cursors, runners };
      }),
    );

    const point = (runner: string, minute: number) => `${runner} ${instant(minute)}`;
    const [, second, , fourth] = found.runners as [string, string, string, string, string];
    expect(found.pages).toEqual([
      [point(second, 0), point(second, 5)],
      [point(second, 10), point(fourth, 0)],
      [point(fourth, 5)],
    ]);
    expect(found.cursors.map((cursor) => cursor !== undefined)).toEqual([true, true, false]);
  });
});

/** One problem a `validation` error names: the parameter and what to change. */
interface Issue {
  readonly path: ReadonlyArray<string>;
  readonly message: string;
}

/** Reads the issues of a `validation` error. */
const readIssues = (error: unknown): ReadonlyArray<Issue> =>
  (error as { readonly error: { readonly details: { readonly issues: ReadonlyArray<Issue> } } })
    .error.details.issues;

describe("a query's limits", () => {
  const refusal = (input: Partial<RunnerMetricsQuery> & Pick<RunnerMetricsQuery, "resolution">) =>
    runAsUser(Effect.flip(query(input)));

  it("refuses a span that is empty or backwards, saying what to change", async () => {
    for (const bounds of [
      { since: instant(10), until: instant(10) },
      { since: instant(10), until: instant(5) },
    ]) {
      const [issue] = readIssues(await refusal({ resolution: "fiveMinutes", ...bounds }));
      expect(issue?.path).toEqual(["since"]);
      expect(issue?.message).toContain("since must be before until");
    }
  });

  it("refuses a since in the future when until is left out", async () => {
    const future = new Date(Date.now() + DAY).toISOString();
    expect(await refusal({ resolution: "hour", since: future })).toMatchObject({
      error: { code: "validation" },
    });
  });

  it("refuses more than 24 hours of five-minute points, and names hour points instead", async () => {
    const error = await refusal({
      resolution: "fiveMinutes",
      since: instant(0),
      until: instant(24 * 60, 1),
    });
    const [issue] = readIssues(error);
    expect(issue?.path).toEqual(["since"]);
    expect(issue?.message).toMatch(/at most 24 hours.*resolution hour/);
  });

  it("accepts exactly 24 hours of five-minute points", async () => {
    const page = await runAsUser(
      query({ resolution: "fiveMinutes", since: instant(0), until: instant(24 * 60) }),
    );
    expect(page.items).toEqual([]);
  });

  it("refuses hour points beyond the longer of the retention and 7 days, and accepts up to it", async () => {
    const hours = (days: number, extraMs = 0) => ({
      resolution: "hour" as const,
      since: instant(0),
      until: instant(days * 24 * 60, extraMs),
    });
    const withRetention = (days: number) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* Settings;
        yield* withTransaction(sql, settings.set("retention.runnerMetrics", days));
      });
    const result = await runAsUser(
      Effect.gen(function* () {
        // Unset, the retention is 14 days.
        const defaultRefused = yield* Effect.flip(query(hours(14, 1)));
        const defaultAccepted = yield* query(hours(14));
        // A retention below 7 days still allows the 7 days the disk forecast reads.
        yield* withRetention(3);
        const shortAccepted = yield* query(hours(7));
        const shortRefused = yield* Effect.flip(query(hours(7, 1)));
        // A retention between 7 and 14 days allows its own length and no more.
        yield* withRetention(10);
        const midAccepted = yield* query(hours(10));
        const midRefused = yield* Effect.flip(query(hours(10, 1)));
        return {
          accepted: [defaultAccepted, shortAccepted, midAccepted].map((page) => page.items),
          refused: [defaultRefused, shortRefused, midRefused],
        };
      }),
    );
    expect(result.accepted).toEqual([[], [], []]);
    expect(result.refused.map((error) => readIssues(error)[0]?.message)).toEqual([
      expect.stringContaining("at most 14 days"),
      expect.stringContaining("at most 7 days"),
      expect.stringContaining("at most 10 days"),
    ]);
  });

  it("refuses a cursor from another runner, resolution or span", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        const service = yield* RunnerMetricsService;
        const runner = yield* insertRunner("iris");
        const other = yield* insertRunner("atlas");
        for (let minute = 0; minute < 15; minute += 5) {
          yield* record(runner, report(50, 8), instant(minute));
        }
        const same = {
          runnerId: runner,
          since: instant(0),
          until: instant(60),
          resolution: "fiveMinutes",
        } as const;
        const cursor = (yield* service.query({ ...same, limit: 1 })).nextCursor!;
        return yield* Effect.forEach(
          [
            { ...same, runnerId: other },
            { ...same, resolution: "hour" },
            { ...same, since: instant(5) },
            { ...same, until: instant(120) },
          ] as const,
          (changed) => Effect.flip(service.query({ ...changed, cursor })),
        );
      }),
    );

    expect(result).toHaveLength(4);
    for (const error of result) {
      expect(readIssues(error)[0]?.path).toEqual(["cursor"]);
    }
  });

  it("reads across a gap longer than a page, one point per page", async () => {
    const found = await runAsUser(
      Effect.gen(function* () {
        const service = yield* RunnerMetricsService;
        const runner = yield* insertRunner("iris");
        yield* record(runner, report(50, 8), instant(0));
        yield* record(runner, report(50, 8), instant(40));
        const points: Array<string> = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = yield* service.query({
            runnerId: runner,
            since: instant(0),
            until: instant(60),
            resolution: "fiveMinutes",
            limit: 1,
            ...(cursor === undefined ? {} : { cursor }),
          });
          points.push(...page.items.map((point) => point.at));
          cursor = page.nextCursor;
          pages++;
        } while (cursor !== undefined);
        return { points, pages };
      }),
    );

    expect(found.points).toEqual([instant(0), instant(40)]);
    // The second page skips the gap in one step, so no page is empty.
    expect(found.pages).toBe(2);
  });
});

describe("the grant", () => {
  const SESSION_WITHOUT_GRANT: Actor = {
    _tag: "session",
    sessionId: "0199e0e7-3333-7000-8000-000000000000",
    profileId: "0199e0e7-4444-7000-8000-000000000000",
    grants: ["task.read"],
    profileGrants: ["task.read"],
    assistantId: null,
    agentId: null,
  };

  const attempt = (actor: Actor | undefined) =>
    Effect.runPromise(
      Effect.flip(query({ resolution: "hour" })).pipe(
        actor === undefined ? (effect) => effect : Effect.provideService(CurrentActor, actor),
        Effect.provide(layer),
      ),
    );

  it("is infra.read, and a caller without it is refused before anything is read", async () => {
    for (const actor of [undefined, SESSION_WITHOUT_GRANT]) {
      expect(await attempt(actor)).toMatchObject({
        error: { code: "forbidden", details: { grant: "infra.read" } },
      });
    }
  });

  it("lets a session that holds it read", async () => {
    const page = await Effect.runPromise(
      query({ resolution: "hour" }).pipe(
        Effect.provideService(CurrentActor, {
          ...SESSION_WITHOUT_GRANT,
          grants: ["infra.read"],
          profileGrants: ["infra.read"],
        }),
        Effect.provide(layer),
        Effect.orDie,
      ),
    );
    expect(page.items).toEqual([]);
  });
});
