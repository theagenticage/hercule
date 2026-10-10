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
 *
 * The tests at the end cover when a connection that ends during a promotion
 * freeze is written. They run here rather than over the socket, because
 * nothing on the socket shows when the controller has handled a close.
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
import { ControllerIdentity } from "../identity";
import { NotifierLayer } from "../notifications";
import { PromotionState, PromotionStateLayer } from "../promotion";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { readEventsOfKind } from "../events/testing";
import {
  mintConnection,
  RunnerConnections,
  RunnerConnectionsLayer,
  type Connection,
  type Departure,
} from "./connections";
import { runnerRepository } from "./repository";

const layer = RunnerConnectionsLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(ServingPromotionStateLayer),
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

/**
 * The connections over a promotion state that can freeze and seal. The
 * identity signs with a fixed run of bytes: these tests check what is written
 * around a promotion, not the key.
 */
const promotableLayer = RunnerConnectionsLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(
    PromotionStateLayer.pipe(
      Layer.provide(
        Layer.succeed(ControllerIdentity, {
          ensure: Effect.die("not used"),
          readOrDie: Effect.die("not used"),
          sign: () => Effect.succeed(new Uint8Array(64).fill(7)),
        }),
      ),
    ),
  ),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** The promotion token every freeze in these tests is for. */
const PROMOTION_TOKEN = "0199f0b7-0000-7000-8000-00000000aaaa";

const HELLO = {
  binaryVersion: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  negotiatedCapabilities: [],
  facts: FACTS,
};

/**
 * Inserts an offline runner, connects it over `connection`, and returns its
 * id. The hello moves the row to online, which records the first change.
 */
const connectRunner = (connection: Connection) =>
  Effect.gen(function* () {
    const connections = yield* RunnerConnections;
    const [runner] = yield* insertFleet([{ connectivity: "offline" }]);
    yield* connections.greeted(runner!.id, connection, HELD, HELLO);
    return runner!.id;
  });

/**
 * Freezes the controller for `PROMOTION_TOKEN`, as a promotion transfer does.
 * The database copy is left out, so the database still accepts writes: a
 * write that ignores the freeze then shows up in the row instead of failing.
 */
const freeze = Effect.flatMap(PromotionState, (promotion) =>
  promotion.freeze(PROMOTION_TOKEN, new Date(Date.now() + 3_600_000)),
);

/**
 * Ends the freeze, as a cancelled transfer does, and then writes the held
 * departures, as the controller daemon does each time the controller serves
 * again.
 */
const thawAndRecordHeldDepartures = Effect.gen(function* () {
  const promotion = yield* PromotionState;
  const connections = yield* RunnerConnections;
  expect(yield* promotion.thaw(PROMOTION_TOKEN)).toBe(true);
  yield* connections.recordHeldDepartures;
});

/**
 * Reads the runner's connectivity now, and every connectivity change the
 * audit log recorded, oldest first. Each test has one runner, so every change
 * is about it.
 */
const readConnectivity = (id: string) =>
  Effect.gen(function* () {
    const runners = yield* runnerRepository;
    const row = Option.getOrThrow(yield* runners.read(id));
    const changes = yield* readEventsOfKind("runner.stateChanged");
    return { now: row.connectivity, changes: changes.map((entry) => entry.payload["state"]) };
  });

/**
 * A promotion freeze copies the database, so a write after the copy would be
 * lost on the new machine. A connection that ends while frozen therefore
 * leaves its runner online until the freeze ends, and once the controller is
 * sealed it never moves the runner off online: the runner follows the new
 * address instead. The socket holds a hello that arrives while frozen until
 * the thaw, so these tests call `greeted` only while serving.
 */
describe("a connection that ends during a promotion freeze", () => {
  it.each(["unreachable", "offline"] as const)(
    "moves its runner to %s only once the freeze ends",
    async (departure: Departure) => {
      const { frozen, thawed } = await Effect.runPromise(
        Effect.gen(function* () {
          const connections = yield* RunnerConnections;
          const connection = mintConnection();
          const id = yield* connectRunner(connection);
          yield* freeze;

          yield* connections.ended(id, connection, departure);
          const frozen = yield* readConnectivity(id);
          yield* thawAndRecordHeldDepartures;
          return { frozen, thawed: yield* readConnectivity(id) };
        }).pipe(Effect.provide(promotableLayer), Effect.orDie),
      );

      expect(frozen, "the copy the new machine took has the runner online").toEqual({
        now: "online",
        changes: ["online"],
      });
      // The held departure keeps its kind: a runner that said goodbye was not
      // lost, so it never reads as unreachable.
      expect(thawed).toEqual({ now: departure, changes: ["online", departure] });
    },
  );

  it.each([
    { written: "the hello is written first", helloFirst: true, changes: ["online"] },
    {
      written: "the held departure is written first",
      helloFirst: false,
      changes: ["online", "unreachable", "online"],
    },
  ])(
    "keeps a runner online that connects again once the freeze ends, when $written",
    async ({ helloFirst, changes }) => {
      const connectivity = await Effect.runPromise(
        Effect.gen(function* () {
          const connections = yield* RunnerConnections;
          const promotion = yield* PromotionState;
          const first = mintConnection();
          const id = yield* connectRunner(first);
          yield* freeze;
          yield* connections.ended(id, first, "unreachable");

          // The socket admits the new connection's hello once the controller
          // serves again, and the controller daemon writes the held
          // departures then too. Either can go first.
          expect(yield* promotion.thaw(PROMOTION_TOKEN)).toBe(true);
          const greetAgain = connections.greeted(id, mintConnection(), HELD, HELLO);
          if (helloFirst) {
            yield* greetAgain;
            yield* connections.recordHeldDepartures;
          } else {
            yield* connections.recordHeldDepartures;
            yield* greetAgain;
          }
          return yield* readConnectivity(id);
        }).pipe(Effect.provide(promotableLayer), Effect.orDie),
      );

      expect(connectivity).toEqual({ now: "online", changes });
    },
  );

  it.each([
    { ends: "while frozen, before the seal", endsBeforeSeal: true },
    { ends: "after the seal", endsBeforeSeal: false },
  ])("never moves its runner off online when it ends $ends", async ({ endsBeforeSeal }) => {
    const connectivity = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const promotion = yield* PromotionState;
        const connection = mintConnection();
        const id = yield* connectRunner(connection);
        yield* freeze;

        const end = connections.ended(id, connection, "unreachable");
        if (endsBeforeSeal) yield* end;
        yield* promotion.seal(PROMOTION_TOKEN, "http://b.test:4937");
        if (!endsBeforeSeal) yield* end;
        // The controller daemon never writes held departures on a sealed
        // controller, because it never serves again. Running the write here
        // shows that it skips them even so.
        yield* connections.recordHeldDepartures;
        return yield* readConnectivity(id);
      }).pipe(Effect.provide(promotableLayer), Effect.orDie),
    );

    expect(connectivity).toEqual({ now: "online", changes: ["online"] });
  });
});
