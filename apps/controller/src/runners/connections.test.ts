/**
 * Tests for how runner rows follow their connections.
 *
 * The first test covers what a controller does at boot about the runners that
 * were connected when it last stopped. A row that reads `online` means a
 * connection is open, and only that connection moves the runner off `online`.
 * A controller that was killed rather than shut down therefore leaves rows
 * that claim runners are ready when nothing is connected, and nothing later
 * corrects them. `strandedByTheLastRun` is the correction. It is tested here
 * rather than over the socket, because it is about the previous run.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import type {
  RunnerConnectivity,
  RunnerFacts,
  RunnerLifecycle,
  RunnerWatermark,
} from "@hercule/contract";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { hashToken } from "../credentials";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { readEventsOfKind } from "../events/testing";
import { mintConnection, RunnerConnections, RunnerConnectionsLayer } from "./connections";
import { runnerRepository } from "./repository";

const layer = RunnerConnectionsLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** One runner row as a stopped controller left it: its connectivity and lifecycle. */
interface Arranged {
  readonly connectivity: RunnerConnectivity;
  readonly lifecycle?: RunnerLifecycle;
}

const insertFleet = (rows: ReadonlyArray<Arranged>) =>
  Effect.gen(function* () {
    const runners = yield* runnerRepository;
    const at = yield* nowIso;
    return yield* Effect.forEach(rows, (row, index) =>
      runners.insert({
        name: `runner-${String(index)}`,
        connectivity: row.connectivity,
        lifecycle: row.lifecycle ?? "active",
        reserved: false,
        labels: [],
        credentialHash: hashToken(crypto.randomUUID()),
        at,
      }),
    );
  });

describe("the fleet a stopped controller left behind", () => {
  it("marks every runner that was online as unreachable, and leaves the rest alone", async () => {
    const { rows, recorded } = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const arranged = yield* insertFleet([
          { connectivity: "online" },
          { connectivity: "offline" },
          { connectivity: "online" },
          { connectivity: "offline", lifecycle: "retired" },
          { connectivity: "online", lifecycle: "draining" },
        ]);

        yield* connections.strandedByTheLastRun;

        const rows = yield* Effect.forEach(arranged, (runner) =>
          Effect.map(runners.read(runner.id), (row) =>
            Option.match(row, {
              onNone: () => "gone",
              onSome: (one) => `${one.connectivity}/${one.lifecycle}`,
            }),
          ),
        );
        const entries = yield* readEventsOfKind("runner.stateChanged");
        return {
          rows,
          recorded: entries.map((entry) => ({
            actor: entry.actor,
            state: entry.payload["state"],
          })),
        };
      }).pipe(Effect.provide(layer), Effect.orDie),
    );

    expect(rows).toEqual([
      "unreachable/active",
      "offline/active",
      "unreachable/active",
      "offline/retired",
      // The user asked for the drain and nothing has cancelled it. A
      // controller restart does not change that.
      "unreachable/draining",
    ]);
    // No user or session asked for this, and a runner is never an actor.
    expect(recorded).toEqual([
      { actor: "system", state: "unreachable" },
      { actor: "system", state: "unreachable" },
      { actor: "system", state: "unreachable" },
    ]);
  });
});

describe("reportUnreachableRunners", () => {
  it("raises one notification per runner unreachable since before the cutoff, and one more after it came back", async () => {
    // The notifications are stamped with the test clock, pinned at `start`,
    // and a runner last seen after a notification was raised about it has
    // come back since.
    const start = Date.parse("2026-09-01T12:00:00.000Z");
    const atMinute = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
    const titles = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start);
        const sql = yield* SqlClient.SqlClient;
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const [early, late, offline, retired] = yield* insertFleet([
          { connectivity: "unreachable" },
          { connectivity: "unreachable" },
          { connectivity: "offline" },
          { connectivity: "unreachable", lifecycle: "retired" },
        ]);
        yield* runners.touch(early!.id, atMinute(-30));
        yield* runners.touch(late!.id, atMinute(-25));
        yield* runners.touch(offline!.id, atMinute(-60));
        yield* runners.touch(retired!.id, atMinute(-60));
        const listTitles = Effect.map(
          sql<{ readonly title: string }>`SELECT title FROM notifications ORDER BY created_at, id`,
          (rows) => rows.map((row) => row.title),
        );

        yield* connections.reportUnreachableRunners(atMinute(-28));
        const first = yield* listTitles;
        yield* connections.reportUnreachableRunners(atMinute(-20));
        const second = yield* listTitles;
        // The early runner came back, and was lost again.
        yield* runners.touch(early!.id, atMinute(1));
        yield* connections.reportUnreachableRunners(atMinute(2));
        const third = yield* listTitles;
        return { first, second, third };
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.orDie),
    );

    expect(titles).toEqual({
      first: ["Runner runner-0 is unreachable"],
      second: ["Runner runner-0 is unreachable", "Runner runner-1 is unreachable"],
      third: [
        "Runner runner-0 is unreachable",
        "Runner runner-1 is unreachable",
        "Runner runner-0 is unreachable",
      ],
    });
  });
});

/** The facts a runner reports about itself; these tests are not about the probe. */
const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [],
  adapters: ["claude-code"],
  identityPort: 4939,
};

const WATERMARK: RunnerWatermark = {
  diskFreeBytes: 200 * 1024 * 1024 * 1024,
  availableMemoryBytes: 1,
};

/** A connection these tests never write to: they test the row, not the socket. */
const HELD = { close: () => undefined, askForFacts: Effect.void, ask: () => Effect.void };

describe("a draining runner whose socket drops", () => {
  it("becomes unreachable without coming off the drain", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const [runner] = yield* insertFleet([{ connectivity: "offline", lifecycle: "draining" }]);

        const connection = mintConnection();
        yield* connections.greeted(runner!.id, connection, HELD, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: FACTS,
        });
        // The runner vanished: it sent no goodbye, the connection just closed.
        yield* connections.ended(runner!.id, connection, "unreachable");

        return yield* runners.read(runner!.id);
      }).pipe(Effect.provide(layer), Effect.orDie),
    );

    const one = Option.getOrThrow(row);
    expect(one.connectivity).toBe("unreachable");
    expect(one.lifecycle).toBe("draining");
  });
});

describe("a report from a connection the runner has replaced", () => {
  it("is dropped, so the older connection cannot overwrite what the newer one reported", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);

        const older = mintConnection();
        const newer = mintConnection();
        yield* connections.greeted(runner!.id, older, HELD, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: FACTS,
        });
        // The runner connected again, and the row now follows the newer connection.
        yield* connections.greeted(runner!.id, newer, HELD, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: { ...FACTS, docker: true },
        });

        // A frame the older connection had already sent, arriving late.
        yield* connections.reportedFacts(runner!.id, older, { ...FACTS, docker: false });
        yield* connections.reportedWatermark(runner!.id, older, WATERMARK);

        return yield* runners.read(runner!.id);
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isSome(row)).toBe(true);
    const one = Option.getOrThrow(row);
    expect(one.facts?.docker, "the newer connection's hello still stands").toBe(true);
    expect(one.watermark, "a stale watermark is not a reading of this machine").toBeNull();
  });
});

describe("a request to a runner", () => {
  const INSTALL = {
    _tag: "installRequest",
    requestId: "install-1",
    providerId: "claude-code",
  } as const;

  const HELLO = {
    binaryVersion: "0.1.0",
    protocolVersion: 1,
    negotiatedCapabilities: [],
    facts: FACTS,
  };

  it("is not sent when the runner has no connection", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
        return yield* connections.asked(runner!.id, INSTALL, Duration.seconds(5));
      }).pipe(Effect.provide(layer), Effect.orDie),
    );

    expect(outcome).toEqual({ _tag: "notSent" });
  });

  it("is unanswered when it was written and the connection then ended", async () => {
    const { outcome, written } = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
        const connection = mintConnection();
        const written: Array<string> = [];
        yield* connections.greeted(
          runner!.id,
          connection,
          {
            ...HELD,
            // The connection closes right after the write, before any answer.
            ask: (frame) =>
              Effect.andThen(
                Effect.sync(() => written.push(frame._tag)),
                Effect.asVoid(
                  Effect.forkDetach(connections.ended(runner!.id, connection, "unreachable")),
                ),
              ),
          },
          HELLO,
        );
        const outcome = yield* connections.asked(runner!.id, INSTALL, Duration.seconds(5));
        return { outcome, written };
      }).pipe(Effect.provide(layer), Effect.orDie),
    );

    expect(written).toEqual(["installRequest"]);
    expect(outcome).toEqual({ _tag: "unanswered" });
  });

  it("is answered with what the runner reported under its id", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
        const connection = mintConnection();
        yield* connections.greeted(
          runner!.id,
          connection,
          {
            ...HELD,
            ask: () =>
              Effect.asVoid(
                Effect.forkDetach(
                  connections.reportedAnswer(runner!.id, connection, {
                    _tag: "installResult",
                    requestId: INSTALL.requestId,
                    ok: true,
                  }),
                ),
              ),
          },
          HELLO,
        );
        return yield* connections.asked(runner!.id, INSTALL, Duration.seconds(5));
      }).pipe(Effect.provide(layer), Effect.orDie),
    );

    expect(outcome).toEqual({
      _tag: "answered",
      answer: { _tag: "installResult", requestId: INSTALL.requestId, ok: true },
    });
  });
});
