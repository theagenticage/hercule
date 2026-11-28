import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { readIssueBlocks } from "./entity-blocks";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  TEST_ORGANIZATION,
  TEST_TOKEN,
  type FakeIssue,
} from "./testing";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The moment every read happens at: midday on a Sunday, UTC. */
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const TODAY_START = Date.UTC(2026, 10, 15);

const access = { token: TEST_TOKEN, organization: TEST_ORGANIZATION };
const ref = (issueId = "7") => `sentry:issue:${TEST_ORGANIZATION.id}/${issueId}`;
const ago = (millis: number): string => new Date(NOW - millis).toISOString();

/** Daily counts from `days` days ago to today, as Sentry sends them. */
const dailyCounts = (days: number): Array<[number, number]> =>
  Array.from({ length: days }, (_, index) => [
    (TODAY_START - (days - 1 - index) * DAY) / 1000,
    index + 1,
  ]);

/** Reads the blocks of `issue` at `NOW`, against a fake Sentry holding only it. */
const read = async (issue: FakeIssue, issueRef = ref(issue.id), override?: () => number) => {
  const fake = buildFakeSentry(buildFakeWorld([issue]));
  if (override !== undefined)
    fake.world.override = (request) =>
      request.path.endsWith("/tags/browser/") ? { status: override() } : undefined;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* Effect.result(readIssueBlocks(access, issueRef));
    }).pipe(Effect.provide(fake.layer), Effect.provide(TestClock.layer())),
  );
  return { result, fake };
};

/** The blocks as the tests read them: every field a block may carry. */
interface ReadBlock {
  type: string;
  caption?: string;
  points?: Array<{ at: string; value: number }>;
  rows?: Array<{ label: string; value: string }>;
  text?: string;
  truncated?: true;
}

const readOk = async (issue: FakeIssue) => {
  const { result } = await read(issue);
  if (Result.isFailure(result)) throw new Error(`read failed: ${JSON.stringify(result.failure)}`);
  return result.success as ReadonlyArray<ReadBlock>;
};

const findFieldRows = (blocks: ReadonlyArray<ReadBlock>) =>
  Object.fromEntries(
    (blocks.find((block) => block.type === "fields")?.rows ?? []).map((row) => [
      row.label,
      row.value,
    ]),
  );

const event = (frameCount: number) => ({
  eventID: "abc123",
  dateCreated: ago(MINUTE),
  release: null,
  environment: null,
  type: "TypeError",
  value: "boom",
  frames: Array.from({ length: frameCount }, (_, index) => ({
    filename: `app/f${String(index)}.ts`,
    function: `fn${String(index)}`,
    lineNo: index + 1,
    colNo: 5,
    inApp: true,
  })),
});

describe("readIssueBlocks", () => {
  it("returns the trend, the fields and the stack trace, in that order", async () => {
    const blocks = await readOk(
      buildFakeIssue("7", { dailyStats: dailyCounts(31), latestEvent: event(2) }),
    );
    expect(blocks.map((block) => block.type)).toEqual(["trend", "fields", "code"]);
  });

  describe("trend", () => {
    it("holds the last 14 UTC days, today last", async () => {
      const [trend] = await readOk(buildFakeIssue("7", { dailyStats: dailyCounts(31) }));
      const points = trend!.points!;
      expect(trend).toMatchObject({ caption: "Events, last 14 days" });
      expect(points).toHaveLength(14);
      expect(points[0]).toEqual({ at: "2026-11-02T00:00:00.000Z", value: 18 });
      expect(points[13]).toEqual({ at: "2026-11-15T00:00:00.000Z", value: 31 });
    });

    it("counts a day Sentry did not list as zero", async () => {
      const stats = dailyCounts(31).filter(
        ([seconds]) => seconds !== (TODAY_START - 3 * DAY) / 1000,
      );
      const [trend] = await readOk(buildFakeIssue("7", { dailyStats: stats }));
      const points = trend!.points!;
      expect(points).toHaveLength(14);
      expect(points[10]).toEqual({ at: "2026-11-12T00:00:00.000Z", value: 0 });
    });

    it("ignores buckets with an impossible time or count, keeping the valid ones", async () => {
      const stats: Array<[number, number]> = [
        [1e20, 5],
        [TODAY_START / 1000, -4],
        [(TODAY_START - DAY) / 1000, 7],
      ];
      const [trend] = await readOk(buildFakeIssue("7", { dailyStats: stats }));
      const points = trend!.points!;
      expect(points).toHaveLength(14);
      expect(points[12]).toEqual({ at: "2026-11-14T00:00:00.000Z", value: 7 });
      expect(points[13]).toEqual({ at: "2026-11-15T00:00:00.000Z", value: 0 });
    });

    it("is left out when no bucket is valid", async () => {
      const blocks = await readOk(buildFakeIssue("7", { dailyStats: [[1e20, 5]] }));
      expect(blocks.map((block) => block.type)).toEqual(["fields"]);
    });

    it("is left out when Sentry sent no daily counts", async () => {
      const blocks = await readOk(buildFakeIssue("7"));
      expect(blocks.map((block) => block.type)).toEqual(["fields"]);
    });
  });

  describe("fields", () => {
    it("shows severity, first and last seen with the release, and users", async () => {
      const blocks = await readOk(
        buildFakeIssue("7", {
          level: "error",
          firstSeen: ago(6 * DAY + HOUR),
          lastSeen: ago(4 * MINUTE),
          firstRelease: "2026.11.06-1",
          userCount: 97,
        }),
      );
      const fields = blocks.find((block) => block.type === "fields");
      expect(fields!.rows!.map((row) => row.label)).toEqual([
        "Severity",
        "First seen",
        "Last seen",
        "Users",
      ]);
      expect(findFieldRows(blocks)).toEqual({
        Severity: "error",
        "First seen": "6 days ago, in 2026.11.06-1",
        "Last seen": "4 minutes ago",
        Users: "97",
      });
    });

    it("leaves out the release of first seen when Sentry knows none", async () => {
      const blocks = await readOk(buildFakeIssue("7", { firstSeen: ago(2 * DAY) }));
      expect(findFieldRows(blocks)["First seen"]).toBe("2 days ago");
    });

    it("shows Resolved and Came back for a regressed issue", async () => {
      const blocks = await readOk(
        buildFakeIssue("7", {
          substatus: "regressed",
          activity: [
            {
              id: "3",
              type: "set_regression",
              dateCreated: ago(35 * MINUTE),
              data: { version: "2026.11.12-1" },
            },
            {
              id: "2",
              type: "set_resolved_in_release",
              dateCreated: ago(8 * DAY),
              data: { version: "2026.11.04-2" },
            },
          ],
        }),
      );
      expect(findFieldRows(blocks)).toEqual({
        Severity: "error",
        Resolved: "8 days ago, in 2026.11.04-2",
        "Came back": "35 minutes ago, in 2026.11.12-1",
        Users: "3",
      });
    });

    it("takes the Resolved release from the regression and drops an empty one", async () => {
      const regressed = (resolvedIn: string, version: string) =>
        buildFakeIssue("7", {
          substatus: "regressed",
          activity: [
            {
              id: "3",
              type: "set_regression",
              dateCreated: ago(HOUR),
              data: { version, resolved_in_version: resolvedIn },
            },
            {
              id: "2",
              type: "set_resolved_in_release",
              dateCreated: ago(3 * DAY),
              data: { version: "from-the-resolve" },
            },
          ],
        });
      expect(findFieldRows(await readOk(regressed("from-the-regression", "")))).toMatchObject({
        Resolved: "3 days ago, in from-the-regression",
        "Came back": "1 hour ago",
      });
      expect(findFieldRows(await readOk(regressed("", "")))).toMatchObject({
        Resolved: "3 days ago, in from-the-resolve",
      });
    });

    it("falls back to first and last seen when a regressed issue has no regression", async () => {
      const blocks = await readOk(buildFakeIssue("7", { substatus: "regressed" }));
      expect(Object.keys(findFieldRows(blocks))).toEqual([
        "Severity",
        "First seen",
        "Last seen",
        "Users",
      ]);
    });

    it("shows the top browser and its share", async () => {
      const blocks = await readOk(
        buildFakeIssue("7", {
          browserTag: {
            totalValues: 100,
            topValues: [
              { name: "Safari 19", count: 61 },
              { name: "Chrome 140", count: 39 },
            ],
          },
        }),
      );
      expect(findFieldRows(blocks)["Browser"]).toBe("Safari 19 · 61%");
    });

    it.each([
      ["a total of zero", 0, 0],
      ["a count above the total", 10, 11],
    ])("has no Browser row for %s", async (_name, totalValues, count) => {
      const blocks = await readOk(
        buildFakeIssue("7", {
          browserTag: { totalValues, topValues: [{ name: "Safari", count }] },
        }),
      );
      expect(findFieldRows(blocks)).not.toHaveProperty("Browser");
    });

    it("leaves out the Severity row when Sentry sends an empty level", async () => {
      const blocks = await readOk(buildFakeIssue("7", { level: "" }));
      expect(Object.keys(findFieldRows(blocks))).toEqual(["First seen", "Last seen", "Users"]);
    });

    it("has no Browser row when the issue has no browser tag", async () => {
      expect(findFieldRows(await readOk(buildFakeIssue("7")))).not.toHaveProperty("Browser");
    });

    it("fails the read when the browser tag cannot be read, instead of hiding it", async () => {
      const { result } = await read(buildFakeIssue("7"), ref("7"), () => 500);
      expect(Result.isFailure(result)).toBe(true);
    });
  });

  describe("time since", () => {
    it.each([
      [4 * MINUTE, "4 minutes ago"],
      [HOUR, "1 hour ago"],
      [24 * HOUR, "yesterday"],
      [6 * DAY, "6 days ago"],
      [14 * DAY, "2 weeks ago"],
      [60 * DAY, "2 months ago"],
      [364 * DAY, "11 months ago"],
      [365 * DAY, "1 year ago"],
      [800 * DAY, "2 years ago"],
    ])("describes %i milliseconds ago as %s", async (elapsed, expected) => {
      const blocks = await readOk(buildFakeIssue("7", { lastSeen: ago(elapsed) }));
      expect(findFieldRows(blocks)["Last seen"]).toBe(expected);
    });
  });

  describe("stack trace", () => {
    it("lists the frames innermost first as at function (file:line:col)", async () => {
      const blocks = await readOk(buildFakeIssue("7", { latestEvent: event(3) }));
      expect(blocks.at(-1)).toEqual({
        type: "code",
        title: "Stack trace",
        text: "at fn2 (app/f2.ts:3:5)\nat fn1 (app/f1.ts:2:5)\nat fn0 (app/f0.ts:1:5)",
      });
    });

    it("keeps the 20 innermost frames and marks the cut", async () => {
      const blocks = await readOk(buildFakeIssue("7", { latestEvent: event(25) }));
      const code = blocks.at(-1)!;
      const lines = code.text!.split("\n");
      expect(lines).toHaveLength(20);
      expect(lines[0]).toBe("at fn24 (app/f24.ts:25:5)");
      expect(lines[19]).toBe("at fn5 (app/f5.ts:6:5)");
      expect(code.truncated).toBe(true);
    });

    it("puts a name with a line or paragraph separator on one line", async () => {
      const blocks = await readOk(
        buildFakeIssue("7", {
          latestEvent: {
            ...event(1),
            frames: [
              {
                filename: "a\u2028b\u2029c.ts",
                function: "f\ng",
                lineNo: 1,
                colNo: 2,
                inApp: true,
              },
            ],
          },
        }),
      );
      expect(blocks.at(-1)!.text).toBe("at f g (a b c.ts:1:2)");
    });

    it("is left out when the event has no frame", async () => {
      const blocks = await readOk(buildFakeIssue("7", { latestEvent: event(0) }));
      expect(blocks.some((block) => block.type === "code")).toBe(false);
    });

    it("is left out when the issue has no event", async () => {
      const blocks = await readOk(buildFakeIssue("7"));
      expect(blocks.some((block) => block.type === "code")).toBe(false);
    });
  });

  describe("failures", () => {
    it("fails before any request for a ref of another organization", async () => {
      const { result, fake } = await read(buildFakeIssue("7"), "sentry:issue:9999/7");
      expect(Result.isFailure(result)).toBe(true);
      expect(fake.requests).toHaveLength(0);
    });

    it("fails before any request for a ref that is not an issue's", async () => {
      const { result, fake } = await read(buildFakeIssue("7"), "sentry:project:4501/11");
      expect(Result.isFailure(result)).toBe(true);
      expect(fake.requests).toHaveLength(0);
    });

    it("fails saying the issue may be deleted or merged when Sentry answers 404", async () => {
      const { result } = await read(buildFakeIssue("7"), ref("8"));
      expect(Result.isFailure(result) && result.failure.message).toMatch(/deleted or merged/);
    });

    it("sends three requests", async () => {
      const { fake } = await read(buildFakeIssue("7"));
      expect(fake.requests).toHaveLength(3);
    });
  });
});
