/**
 * Tests the ingest loops on a `TestClock`: when each feed is polled, how
 * failures back off and set the Connection's status, and how a handle is
 * closed. The plugin is the scripted fixture from `./testing`; the host, the
 * database and the notifier are real.
 */
import { describe, expect, it } from "vitest";
import { Clock, Duration, Effect, Fiber, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AuthError, PluginError, type FeedDeclaration } from "@hercule/plugin-host";
import { MAX_FEED_INTERVAL_SECONDS } from "@hercule/contract";
import { connectionRepository, type StoredConnection } from "../connections";
import { nowIso } from "../db";
import { Secrets } from "../secrets";
import {
  CLOSE_TIMEOUT_SECONDS,
  computeFeedInterval,
  computeRetryDelay,
  FAILURES_BEFORE_ERROR,
  IngestLoops,
  POLL_TIMEOUT_SECONDS,
} from "./ingest";
import { PluginHost } from "./index";
import {
  asUser,
  buildPluginStack,
  createEventSourceFixture,
  EVENT_SOURCE_FIXTURE,
  insertFixtureConnection,
  type EventSourceFixture,
} from "./testing";

const START = Date.parse("2026-09-01T12:00:00.000Z");

/** Runs a test body on a fresh plugin stack and a `TestClock` set to `START`. */
const run = <A, E>(
  body: Effect.Effect<A, E, PluginHost | IngestLoops | Secrets | SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(START), body).pipe(
      Effect.provide(buildPluginStack()),
      Effect.provide(TestClock.layer()),
      asUser,
    ),
  );

/** Moves the clock forward by whole seconds, running every timer that comes due. */
const advance = (seconds: number) => TestClock.adjust(Duration.seconds(seconds));

/** Returns the seconds since `START` on the test clock. */
const readElapsedSeconds = Effect.map(Clock.currentTimeMillis, (now) => (now - START) / 1000);

/**
 * Boots the fixture's plugin, inserts one Connection named `work` of its type,
 * and opens it. The feed intervals are stored before the open, as the user
 * would have set them.
 */
const openConnection = (
  fixture: EventSourceFixture,
  feedIntervals: Readonly<Record<string, number>> = {},
) =>
  Effect.gen(function* () {
    const host = yield* PluginHost;
    yield* host.boot([fixture.plugin]);
    const connection = yield* insertFixtureConnection({ feedIntervals });
    const source = (yield* host.listActiveEventSources())[0];
    if (source === undefined) return yield* Effect.die("the fixture registered no source");
    const ingest = yield* IngestLoops;
    yield* ingest.open(source, connection);
    yield* advance(0);
    return { connection, ingest };
  });

/** Reads the Connection's status and detail. */
const readStatus = (connection: StoredConnection) =>
  Effect.gen(function* () {
    const connections = yield* connectionRepository;
    const stored = Option.getOrThrow(yield* connections.one(connection.id));
    return { status: stored.status, detail: stored.statusDetail };
  });

/** Lists the titles of the `core.connection-error` notifications, oldest first. */
const listConnectionErrorTitles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly title: string }>`
    SELECT title FROM notifications WHERE kind = 'core.connection-error' ORDER BY created_at, id
  `;
  return rows.map((row) => row.title);
});

/** Makes the fixture record the second each poll starts at, and returns that list. */
const recordPollTimes = (fixture: EventSourceFixture, feed: string): Array<number> => {
  const times: Array<number> = [];
  const poll = fixture.poll;
  fixture.poll = (polled) =>
    polled === feed
      ? Effect.andThen(
          Effect.map(readElapsedSeconds, (seconds) => times.push(seconds)),
          poll(polled),
        )
      : poll(polled);
  return times;
};

const failWithBadGateway = () => Effect.fail(new PluginError({ message: "Acme answered 502" }));

describe("computeFeedInterval", () => {
  const feed: FeedDeclaration = { defaultIntervalSeconds: 60, minIntervalSeconds: 30 };

  it.each([
    ["no interval of its own gets the default", feed, undefined, 60],
    ["its own interval above the minimum keeps it", feed, 45, 45],
    ["its own interval below the minimum gets the minimum", feed, 10, 30],
    ["no minimum has the default as its minimum", { defaultIntervalSeconds: 60 }, 10, 60],
  ] as const)("a Connection with %s", (_, declaration, override, expected) => {
    expect(computeFeedInterval(declaration, override)).toBe(expected);
  });
});

describe("computeRetryDelay", () => {
  it("doubles the interval per failure up to 15 minutes", () => {
    expect([1, 2, 3, 4, 5].map((failures) => computeRetryDelay(60, failures))).toEqual([
      120, 240, 480, 900, 900,
    ]);
  });

  it("never waits less than the interval itself", () => {
    expect(computeRetryDelay(3600, 3)).toBe(3600);
  });
});

describe("IngestLoops polling", () => {
  it("polls each feed right after the open, then once per interval", async () => {
    const fixture = createEventSourceFixture({
      feeds: {
        notifications: { defaultIntervalSeconds: 60 },
        repos: { defaultIntervalSeconds: 300 },
      },
    });
    const notifications = recordPollTimes(fixture, "notifications");
    const repos = recordPollTimes(fixture, "repos");

    await run(
      Effect.gen(function* () {
        yield* openConnection(fixture);
        yield* advance(300);
      }),
    );

    expect(notifications).toEqual([0, 60, 120, 180, 240, 300]);
    expect(repos).toEqual([0, 300]);
    expect(fixture.calls.filter((call) => call === "open")).toHaveLength(1);
  });

  it("uses the Connection's own interval, but never one below the feed's minimum", async () => {
    const fixture = createEventSourceFixture({
      feeds: {
        notifications: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
        repos: { defaultIntervalSeconds: 300 },
      },
    });
    const notifications = recordPollTimes(fixture, "notifications");
    const repos = recordPollTimes(fixture, "repos");

    await run(
      Effect.gen(function* () {
        yield* openConnection(fixture, { notifications: 10, repos: 600 });
        yield* advance(600);
      }),
    );

    expect(notifications.slice(0, 4)).toEqual([0, 30, 60, 90]);
    expect(repos).toEqual([0, 600]);
  });

  it("waits as long as the external system asks, but never less than the interval", async () => {
    const fixture = createEventSourceFixture();
    const hints = [200, 10];
    fixture.poll = () => Effect.succeed({ nextAfterSeconds: hints.shift() ?? 0 });
    const times = recordPollTimes(fixture, "notifications");

    await run(
      Effect.gen(function* () {
        yield* openConnection(fixture);
        yield* advance(320);
      }),
    );

    expect(times).toEqual([0, 200, 260, 320]);
  });

  it("ignores a wait that is not a finite number, and caps a longer one at one day", async () => {
    const fixture = createEventSourceFixture();
    const hints = [Number.NaN, Number.POSITIVE_INFINITY, 1e9];
    fixture.poll = () => Effect.succeed({ nextAfterSeconds: hints.shift() ?? 0 });
    const times = recordPollTimes(fixture, "notifications");

    await run(
      Effect.gen(function* () {
        yield* openConnection(fixture);
        yield* advance(120 + MAX_FEED_INTERVAL_SECONDS);
      }),
    );

    expect(times).toEqual([0, 60, 120, 120 + MAX_FEED_INTERVAL_SECONDS]);
  });

  it("never runs two polls of one handle at a time", async () => {
    const fixture = createEventSourceFixture({
      feeds: {
        notifications: { defaultIntervalSeconds: 60 },
        repos: { defaultIntervalSeconds: 60 },
      },
    });
    fixture.poll = () => Effect.as(Effect.sleep(Duration.seconds(20)), {});

    await run(
      Effect.gen(function* () {
        yield* openConnection(fixture);
        yield* advance(200);
      }),
    );

    expect(fixture.calls.filter((call) => call.startsWith("poll ")).length).toBeGreaterThan(4);
    expect(fixture.countMostPollsAtOnce()).toBe(1);
  });
});

describe("IngestLoops failures", () => {
  it("backs off, sets error with one notification at the fifth failure, and keeps polling", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = failWithBadGateway;
    const times = recordPollTimes(fixture, "notifications");

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(840);
        const afterFour = yield* readStatus(connection);
        yield* advance(900);
        const afterFive = yield* readStatus(connection);
        yield* advance(1800);
        return {
          afterFour,
          afterFive,
          afterSeven: yield* readStatus(connection),
          titles: yield* listConnectionErrorTitles,
        };
      }),
    );

    // Waits of 120, 240, 480, then 900 seconds, the cap.
    expect(times).toEqual([0, 120, 360, 840, 1740, 2640, 3540]);
    expect(seen.afterFour).toEqual({ status: "connected", detail: undefined });
    expect(seen.afterFive).toEqual({ status: "error", detail: "Acme answered 502" });
    expect(seen.afterSeven.status).toBe("error");
    expect(seen.titles).toEqual(["Acme connection 'work' keeps failing"]);
  });

  it("sets the Connection back to connected after a success, with the detail cleared", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = failWithBadGateway;

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(1740);
        const failed = yield* readStatus(connection);
        fixture.poll = () => Effect.succeed({});
        yield* advance(900);
        return { failed, recovered: yield* readStatus(connection) };
      }),
    );

    expect(seen.failed.status).toBe("error");
    expect(seen.recovered).toEqual({ status: "connected", detail: undefined });
  });

  it("keeps an error Connection in error when it is opened again and its feed still fails", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = failWithBadGateway;

    const seen = await run(
      Effect.gen(function* () {
        const { connection, ingest } = yield* openConnection(fixture);
        yield* advance(1740);
        const before = (yield* readStatus(connection)).status;
        const notesBefore = (yield* listConnectionErrorTitles).length;
        yield* ingest.close(connection.id);
        // Opened again as the reconciler would: from the Connection as it is now stored.
        const stored = Option.getOrThrow(
          yield* Effect.flatMap(connectionRepository, (connections) =>
            connections.one(connection.id),
          ),
        );
        const source = (yield* Effect.flatMap(PluginHost, (host) =>
          host.listActiveEventSources(),
        ))[0];
        if (source === undefined) return yield* Effect.die("the fixture registered no source");
        yield* ingest.open(source, stored);
        yield* advance(0);
        const afterReopen = (yield* readStatus(connection)).status;
        yield* advance(1740);
        return {
          before,
          notesBefore,
          afterReopen,
          after: (yield* readStatus(connection)).status,
          notes: (yield* listConnectionErrorTitles).length,
        };
      }),
    );

    expect(seen).toEqual({
      before: "error",
      notesBefore: 1,
      afterReopen: "error",
      after: "error",
      notes: 1,
    });
  });

  it("keeps a Connection in error until every feed has polled successfully", async () => {
    const fixture = createEventSourceFixture({
      feeds: {
        notifications: { defaultIntervalSeconds: 60 },
        repos: { defaultIntervalSeconds: 60 },
      },
    });
    fixture.poll = (feed) => (feed === "notifications" ? failWithBadGateway() : Effect.succeed({}));

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(1740);
        const failed = (yield* readStatus(connection)).status;
        yield* advance(600);
        const stillFailing = (yield* readStatus(connection)).status;
        fixture.poll = () => Effect.succeed({});
        yield* advance(900);
        return { failed, stillFailing, recovered: (yield* readStatus(connection)).status };
      }),
    );

    expect(seen).toEqual({ failed: "error", stillFailing: "error", recovered: "connected" });
  });

  it("stops a poll that runs longer than 5 minutes, and counts it as a failure", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = () => Effect.never;
    const times = recordPollTimes(fixture, "notifications");

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(3240);
        return yield* readStatus(connection);
      }),
    );

    // Each poll is stopped after 300 seconds, then waits 120, 240, 480 and 900 seconds.
    expect(times).toEqual([0, 420, 960, 1740, 2940]);
    expect(seen.status).toBe("error");
    expect(seen.detail).toContain(`stopped after ${POLL_TIMEOUT_SECONDS} seconds`);
  });

  it("does not count a poll whose emit is refused because the Connection was disabled", async () => {
    const fixture = createEventSourceFixture();
    let emitted = 0;
    fixture.poll = () => {
      const handle = fixture.opened[0];
      if (handle === undefined) return Effect.die("the source was never opened");
      emitted += 1;
      return Effect.as(
        handle.context.emit({
          kind: EVENT_SOURCE_FIXTURE.kind,
          dedupKey: `thing-${emitted}`,
          occurredAt: "2026-09-01T12:00:00Z",
          payload: { title: "Shipped" },
          refs: [],
        }),
        {},
      );
    };
    const times = recordPollTimes(fixture, "notifications");

    const written = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        const connections = yield* connectionRepository;
        yield* connections.update(connection.id, { status: "disabled" }, yield* nowIso);
        yield* advance(300);
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly dedupKey: string }>`
          SELECT dedup_key AS dedupKey FROM events WHERE kind = ${EVENT_SOURCE_FIXTURE.kind}
        `;
      }),
    );

    // Not counted, so the feed keeps its interval instead of backing off.
    expect(times).toEqual([0, 60, 120, 180, 240, 300]);
    expect(written).toEqual([{ dedupKey: "thing-1" }]);
  });

  it("counts a crash in poll as a failure", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = () => Effect.die(new Error("undefined is not a function"));

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(1740);
        return yield* readStatus(connection);
      }),
    );

    expect(seen).toEqual({ status: "error", detail: "undefined is not a function" });
  });

  it("leaves a status the user set while the polls were failing", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = failWithBadGateway;

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        const connections = yield* connectionRepository;
        yield* connections.update(connection.id, { status: "disabled" }, yield* nowIso);
        yield* advance(1740);
        return { status: yield* readStatus(connection), titles: yield* listConnectionErrorTitles };
      }),
    );

    expect(seen.status.status).toBe("disabled");
    expect(seen.titles).toEqual([]);
  });

  it("sets needs-reauth at the first AuthError, closes the handle and stops polling", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = () => Effect.fail(new AuthError({ message: "Acme rejected the token" }));

    const seen = await run(
      Effect.gen(function* () {
        const { connection, ingest } = yield* openConnection(fixture);
        yield* advance(3600);
        return { status: yield* readStatus(connection), open: yield* ingest.listOpen() };
      }),
    );

    expect(seen.status).toEqual({ status: "needs-reauth", detail: "Acme rejected the token" });
    expect(fixture.calls).toEqual(["open", "poll notifications", "polled notifications", "close"]);
    expect(seen.open).toEqual([]);
  });

  it("ignores an AuthError when the credentials were replaced while the poll ran", async () => {
    const fixture = createEventSourceFixture();

    const seen = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        let polls = 0;
        // The first poll is rejected, but the user reconnects with a new token
        // before the rejection comes back.
        fixture.poll = () => {
          polls += 1;
          const handle = fixture.opened[0];
          if (polls > 1 || handle === undefined) return Effect.succeed({});
          const owner = { kind: "connection", id: handle.connection.id } as const;
          return Effect.andThen(
            Effect.orDie(secrets.set(owner, "token", Redacted.make("a-new-token"))),
            Effect.fail(new AuthError({ message: "Acme rejected the token" })),
          );
        };
        const { connection, ingest } = yield* openConnection(fixture);
        yield* advance(60);
        return {
          status: yield* readStatus(connection),
          open: yield* ingest.listOpen(),
          calls: [...fixture.calls],
        };
      }),
    );

    expect(seen.status).toEqual({ status: "connected", detail: undefined });
    // Polled again one interval later, with the handle still open.
    expect(seen.calls.filter((call) => call === "poll notifications")).toHaveLength(2);
    expect(seen.calls).not.toContain("close");
    expect(seen.open).toHaveLength(1);
  });
});

describe("IngestLoops opening", () => {
  it("retries a failing open with backoff, counting toward error like a poll", async () => {
    const fixture = createEventSourceFixture();
    let failures = FAILURES_BEFORE_ERROR;
    fixture.open = () =>
      failures-- > 0 ? Effect.fail(new PluginError({ message: "Acme is down" })) : Effect.void;

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(1740);
        const failed = yield* readStatus(connection);
        yield* advance(900);
        return {
          failed,
          opened: yield* readStatus(connection),
          titles: yield* listConnectionErrorTitles,
        };
      }),
    );

    expect(seen.failed).toEqual({ status: "error", detail: "Acme is down" });
    expect(seen.opened).toEqual({ status: "connected", detail: undefined });
    expect(seen.titles).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "open")).toHaveLength(6);
    // The handle polls once it opens, and the stack closes it when the test ends.
    expect(fixture.calls.slice(-4)).toEqual([
      "open",
      "poll notifications",
      "polled notifications",
      "close",
    ]);
  });

  it("sets needs-reauth when the open fails with an AuthError, and never polls", async () => {
    const fixture = createEventSourceFixture();
    fixture.open = () => Effect.fail(new AuthError({ message: "Acme rejected the token" }));

    const seen = await run(
      Effect.gen(function* () {
        const { connection } = yield* openConnection(fixture);
        yield* advance(600);
        return yield* readStatus(connection);
      }),
    );

    expect(seen).toEqual({ status: "needs-reauth", detail: "Acme rejected the token" });
    expect(fixture.calls).toEqual(["open"]);
  });

  it("passes the Connection's id and config to open", async () => {
    const fixture = createEventSourceFixture();

    const connection = await run(
      Effect.map(openConnection(fixture), (opened) => opened.connection),
    );

    expect(fixture.opened.map((one) => one.connection)).toEqual([
      { id: connection.id, config: {} },
    ]);
  });
});

describe("IngestLoops closing", () => {
  it("interrupts a running poll, then calls close once, and polls no more", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = () => Effect.as(Effect.sleep(Duration.seconds(30)), {});

    const seen = await run(
      Effect.gen(function* () {
        const { connection, ingest } = yield* openConnection(fixture);
        yield* advance(10);
        yield* ingest.close(connection.id);
        const calls = [...fixture.calls];
        yield* advance(600);
        return { calls, open: yield* ingest.listOpen() };
      }),
    );

    expect(seen.calls).toEqual(["open", "poll notifications", "polled notifications", "close"]);
    expect(fixture.calls).toEqual(seen.calls);
    expect(seen.open).toEqual([]);
  });

  it("closes every Connection of a plugin when the plugin stops", async () => {
    const fixture = createEventSourceFixture();

    const open = await run(
      Effect.gen(function* () {
        const { ingest } = yield* openConnection(fixture);
        const host = yield* PluginHost;
        yield* host.stop(EVENT_SOURCE_FIXTURE.pluginId);
        return yield* ingest.listOpen();
      }),
    );

    expect(open).toEqual([]);
    expect(fixture.calls.at(-1)).toBe("close");
  });

  it("gives up on a close that does not return within 10 seconds", async () => {
    const fixture = createEventSourceFixture();
    fixture.close = () => Effect.never;

    const open = await run(
      Effect.gen(function* () {
        const { connection, ingest } = yield* openConnection(fixture);
        const closing = yield* Effect.forkChild(ingest.close(connection.id));
        yield* advance(CLOSE_TIMEOUT_SECONDS);
        yield* Fiber.join(closing);
        return yield* ingest.listOpen();
      }),
    );

    expect(open).toEqual([]);
    expect(fixture.calls.at(-1)).toBe("close");
  });
});
