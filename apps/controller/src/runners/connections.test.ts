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
import { Duration, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  RunnerConnectivity,
  RunnerFacts,
  RunnerLifecycle,
  RunnerWatermark,
} from "@hercule/contract";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PROTOCOL_VERSION,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  type ControllerToRunner,
  type SessionInput,
  type SessionInputResult,
} from "@hercule/protocol";
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

it("refuses inspection immediately on the current unsupported connection", async () => {
  const written: Array<ControllerToRunner> = [];
  const answer = await Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* RunnerConnections;
      const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
      yield* connections.greeted(
        runner!.id,
        mintConnection(),
        { ...HELD, ask: (frame) => Effect.sync(() => written.push(frame)) },
        {
          binaryVersion: "0.1.0",
          protocolVersion: PROTOCOL_VERSION,
          negotiatedCapabilities: [],
          facts: FACTS,
        },
      );
      return yield* connections.asked(
        runner!.id,
        { _tag: "workspaceInspect", requestId: "inspect-request", workspaceId: "workspace" },
        Duration.infinity,
      );
    }).pipe(Effect.provide(layer)),
  );
  expect(written).toEqual([]);
  expect(Option.isNone(answer)).toBe(true);
});

it("refuses attachment frames when a capable runner reconnects with an older binary", async () => {
  const written: Array<ControllerToRunner> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* RunnerConnections;
      const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
      const hello = {
        binaryVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
        negotiatedCapabilities: [WORKSPACE_LIFECYCLE_CAPABILITY],
        facts: FACTS,
      };
      yield* connections.greeted(runner!.id, mintConnection(), HELD, hello);
      yield* connections.greeted(
        runner!.id,
        mintConnection(),
        { ...HELD, ask: (frame) => Effect.sync(() => written.push(frame)) },
        { ...hello, negotiatedCapabilities: [] },
      );
      const sent = yield* connections.tell(runner!.id, {
        _tag: "workspaceProvision",
        workspaceId: "workspace-attachment",
        kind: "primary",
        attachment: { path: "/checkout", remoteName: "origin" },
        checkouts: [],
      });
      const report = yield* connections.fleetTraffic.pipe(Stream.runHead);
      return { sent, report: Option.getOrThrow(report) };
    }).pipe(Effect.provide(layer)),
  );
  expect(result.sent).toBe(false);
  expect(written).toEqual([]);
  expect(result.report).toMatchObject({
    _tag: "workspaceReported",
    report: {
      workspaceId: "workspace-attachment",
      status: "failed",
    },
  });
  if (result.report._tag !== "workspaceReported") throw new Error("Expected workspace failure");
  expect(result.report.report.message).toMatch(/upgrade/i);
});

it.each([
  { _tag: "workspaceDispose", workspaceId: "workspace", requestId: "ordinary-disposal" },
  {
    _tag: "workspaceDispose",
    workspaceId: "workspace",
    requestId: "forced-disposal",
    discardChanges: true,
  },
  { _tag: "workspaceDetach", workspaceId: "workspace", requestId: "detach-registration" },
] as const)(
  "refuses $requestId on a replacement runner that lacks safe lifecycle support",
  async (frame) => {
    const written: Array<ControllerToRunner> = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
        const hello = {
          binaryVersion: "0.1.0",
          protocolVersion: PROTOCOL_VERSION,
          negotiatedCapabilities: [WORKSPACE_LIFECYCLE_CAPABILITY],
          facts: FACTS,
        };
        yield* connections.greeted(runner!.id, mintConnection(), HELD, hello);
        yield* connections.greeted(
          runner!.id,
          mintConnection(),
          { ...HELD, ask: (message) => Effect.sync(() => written.push(message)) },
          { ...hello, negotiatedCapabilities: [] },
        );
        const sent = yield* connections.tell(runner!.id, frame);
        const report = yield* connections.fleetTraffic.pipe(Stream.runHead);
        return { sent, report: Option.getOrThrow(report) };
      }).pipe(Effect.provide(layer)),
    );
    expect(result.sent).toBe(false);
    expect(written).toEqual([]);
    expect(result.report).toMatchObject({
      _tag: "workspaceReported",
      report: { workspaceId: frame.workspaceId, requestId: frame.requestId, status: "failed" },
    });
    if (result.report._tag !== "workspaceReported") throw new Error("Expected workspace failure");
    expect(result.report.report.message).toMatch(/upgrade/i);
  },
);

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
          protocolVersion: PROTOCOL_VERSION,
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
          protocolVersion: PROTOCOL_VERSION,
          negotiatedCapabilities: [],
          facts: FACTS,
        });
        // The runner connected again, and the row now follows the newer connection.
        yield* connections.greeted(runner!.id, newer, HELD, {
          binaryVersion: "0.1.0",
          protocolVersion: PROTOCOL_VERSION,
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

/** A frame that carries an input, as a send of that input writes it. */
const INPUT_FRAME: SessionInput = {
  _tag: "sessionInput",
  requestId: "input-1",
  sessionId: "session-1",
  input: { text: "hello" },
};

describe("sendFrameCarryingInput", () => {
  it("returns notSent for a runner with no connection", async () => {
    const sent = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        return yield* connections.sendFrameCarryingInput(
          crypto.randomUUID(),
          INPUT_FRAME,
          Duration.infinity,
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(sent).toEqual({ _tag: "notSent" });
  });

  it("writes the frame, then returns the runner's answer to it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
        const written: Array<ControllerToRunner> = [];
        const connection = mintConnection();
        yield* connections.greeted(
          runner!.id,
          connection,
          { ...HELD, ask: (frame) => Effect.sync(() => written.push(frame)) },
          {
            binaryVersion: "0.1.0",
            protocolVersion: PROTOCOL_VERSION,
            negotiatedCapabilities: [],
            facts: FACTS,
          },
        );

        const sending = yield* Effect.forkChild(
          connections.sendFrameCarryingInput(runner!.id, INPUT_FRAME, Duration.infinity),
        );
        while (written.length === 0) yield* Effect.yieldNow;
        const answer: SessionInputResult = {
          _tag: "sessionInputResult",
          requestId: INPUT_FRAME.requestId,
          ok: true,
          delivery: "opened",
        };
        yield* connections.reportedAnswer(runner!.id, connection, answer);
        return { written, sent: yield* Fiber.join(sending), answer };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.written).toEqual([INPUT_FRAME]);
    expect(result.sent).toEqual({ _tag: "sent", answer: Option.some(result.answer) });
  });

  it("returns sent with no answer when the connection ends after the write", async () => {
    const { sent, written } = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
        const connection = mintConnection();
        const written: Array<ControllerToRunner> = [];
        yield* connections.greeted(
          runner!.id,
          connection,
          {
            ...HELD,
            // The connection closes right after the write, before any answer.
            ask: (frame) =>
              Effect.andThen(
                Effect.sync(() => written.push(frame)),
                Effect.asVoid(
                  Effect.forkDetach(connections.ended(runner!.id, connection, "unreachable")),
                ),
              ),
          },
          {
            binaryVersion: "0.1.0",
            protocolVersion: PROTOCOL_VERSION,
            negotiatedCapabilities: [],
            facts: FACTS,
          },
        );
        const sent = yield* connections.sendFrameCarryingInput(
          runner!.id,
          INPUT_FRAME,
          Duration.infinity,
        );
        return { sent, written };
      }).pipe(Effect.provide(layer)),
    );

    // The runner may have the input, so the caller must not treat it as never sent.
    expect(written).toEqual([INPUT_FRAME]);
    expect(sent).toEqual({ _tag: "sent", answer: Option.none() });
  });
});
