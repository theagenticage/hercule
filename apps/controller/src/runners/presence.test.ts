/**
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
import type { RunnerState } from "@hydra/contract";
import { hashToken } from "../credentials";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { RunnerPresence, RunnerPresenceLayer } from "./presence";
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
