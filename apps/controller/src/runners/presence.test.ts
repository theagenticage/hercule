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
import type { RunnerFacts, RunnerState, RunnerWatermark } from "@hydra/contract";
import { hashToken } from "../credentials";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { newConnection, RunnerPresence, RunnerPresenceLayer } from "./presence";
import { runnerRepository } from "./repository";

const layer = RunnerPresenceLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** Arranges a fleet in the states a stopped controller would have left it in. */
const fleetOf = (states: ReadonlyArray<RunnerState>) =>
  Effect.gen(function* () {
    const runners = yield* runnerRepository;
    const at = yield* nowIso;
    return yield* Effect.forEach(states, (state, index) =>
      runners.insert({
        name: `runner-${String(index)}`,
        state,
        labels: [],
        maxConcurrentSessions: 1,
        credentialHash: hashToken(crypto.randomUUID()),
        at,
      }),
    );
  });

describe("the fleet a stopped controller left behind", () => {
  it("reads every runner it was holding as unreachable, and leaves the rest alone", async () => {
    const { states, recorded } = await Effect.runPromise(
      Effect.gen(function* () {
        const presence = yield* RunnerPresence;
        const runners = yield* runnerRepository;
        const audit = yield* AuditLog;
        const arranged = yield* fleetOf(["online", "offline", "online", "retired"]);

        yield* presence.strandedByTheLastRun;

        const states = yield* Effect.forEach(arranged, (runner) =>
          Effect.map(runners.read(runner.id), (row) =>
            Option.match(row, { onNone: () => "gone", onSome: (one) => one.state }),
          ),
        );
        const entries = yield* audit.listByKind("runner.stateChanged");
        return {
          states,
          recorded: entries.map((entry) => ({
            actor: entry.actor,
            state: entry.payload["state"],
          })),
        };
      }).pipe(Effect.provide(layer), Effect.orDie),
    );

    expect(states).toEqual(["unreachable", "offline", "unreachable", "retired"]);
    // Nobody holding a credential asked for this, and a runner is never an actor.
    expect(recorded).toEqual([
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
  identityPort: 4939,
};

const WATERMARK: RunnerWatermark = {
  diskFreeBytes: 200 * 1024 * 1024 * 1024,
  availableMemoryBytes: 1,
  acceptingPlacements: true,
};

describe("a report from a connection the runner has replaced", () => {
  it("is dropped, so the older socket cannot put its machine back over the newer one", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const presence = yield* RunnerPresence;
        const runners = yield* runnerRepository;
        const [runner] = yield* fleetOf(["offline"]);

        const older = newConnection();
        const newer = newConnection();
        yield* presence.greeted(runner!.id, older, () => undefined, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: FACTS,
        });
        // The machine dialled again, and the row is the newer connection's now.
        yield* presence.greeted(runner!.id, newer, () => undefined, {
          binaryVersion: "0.1.0",
          protocolVersion: 1,
          negotiatedCapabilities: [],
          facts: { ...FACTS, docker: true },
        });

        // A frame the older connection had already sent, arriving late.
        yield* presence.reportedFacts(runner!.id, older, { ...FACTS, docker: false });
        yield* presence.reportedWatermark(runner!.id, older, WATERMARK);

        return yield* runners.read(runner!.id);
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isSome(row)).toBe(true);
    const one = Option.getOrThrow(row);
    expect(one.facts?.docker, "the newer connection's hello still stands").toBe(true);
    expect(one.watermark, "a stale watermark is not a reading of this machine").toBeNull();
  });
});
