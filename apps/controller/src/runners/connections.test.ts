/**
 * Two rules about which connection a runner's row follows.
 *
 * What a controller does about the fleet it was holding when it stopped.
 *
 * A row saying `online` means a connection is open, and the only thing that
 * moves a runner off `online` is the connection that put it there. A controller
 * that was killed rather than drained therefore leaves rows claiming machines
 * are ready for work that nothing is connected to, and nothing later in the
 * process's life corrects them. This is the correction, and it is asserted here
 * rather than over the wire because what it is about is the run before this one.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import type {
  RunnerConnectivity,
  RunnerFacts,
  RunnerLifecycle,
  RunnerWatermark,
} from "@hydra/contract";
import { hashToken } from "../credentials";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { newConnection, RunnerConnections, RunnerConnectionsLayer } from "./connections";
import { runnerRepository } from "./repository";

const layer = RunnerConnectionsLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** One row as a stopped controller would have left it: where it stood, and how. */
interface Arranged {
  readonly connectivity: RunnerConnectivity;
  readonly lifecycle?: RunnerLifecycle;
}

const fleetOf = (rows: ReadonlyArray<Arranged>) =>
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
  it("reads every runner it was holding as unreachable, and leaves the rest alone", async () => {
    const { rows, recorded } = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const audit = yield* AuditLog;
        const arranged = yield* fleetOf([
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
        const entries = yield* audit.listByKind("runner.stateChanged");
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
      // The user asked for the drain and nothing has cancelled it; that a
      // controller restarted says nothing about it either way.
      "unreachable/draining",
    ]);
    // Nobody holding a credential asked for this, and a runner is never an actor.
    expect(recorded).toEqual([
      { actor: "system", state: "unreachable" },
      { actor: "system", state: "unreachable" },
      { actor: "system", state: "unreachable" },
    ]);
  });
});

/** What a machine says about itself; nothing here is about the probe. */
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

/** A connection this file never writes to: its subject is the row, not the wire. */
const HELD = { close: () => undefined, askForFacts: Effect.void, ask: () => Effect.void };

describe("a draining runner whose socket drops", () => {
  it("becomes unreachable without coming off the drain", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const [runner] = yield* fleetOf([{ connectivity: "offline", lifecycle: "draining" }]);

        const connection = newConnection();
        yield* connections.greeted(runner!.id, connection, HELD, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: FACTS,
        });
        // The machine vanished: nothing announced it, the connection simply went.
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
  it("is dropped, so the older socket cannot put its machine back over the newer one", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const connections = yield* RunnerConnections;
        const runners = yield* runnerRepository;
        const [runner] = yield* fleetOf([{ connectivity: "offline" }]);

        const older = newConnection();
        const newer = newConnection();
        yield* connections.greeted(runner!.id, older, HELD, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: FACTS,
        });
        // The machine dialled again, and the row is the newer connection's now.
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
