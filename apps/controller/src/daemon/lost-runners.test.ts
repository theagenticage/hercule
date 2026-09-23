/**
 * Tests the sweep around `SessionService.endOnLostRunners`: what it passes to
 * the rule, and when the first pass runs. The rule itself is tested with the
 * sessions service.
 *
 * The service is a stub that records each call, because these tests only
 * check what the sweep calls and when.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { SessionService } from "../sessions";
import { sweepSessionsOnLostRunners } from "./lost-runners";

const at = "2026-09-22T10:00:00.000Z";

/** Builds a runner row with this connectivity, the only field the sweep reads. */
const insertRunner = (connectivity: "online" | "unreachable") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    const name = uuidToString(id);
    yield* sql`
      INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                           credential_hash, created_at, updated_at)
      VALUES (${id}, ${name}, ${connectivity}, 'active', 0, '[]', ${name}, ${at}, ${at})
    `;
    return name;
  });

describe("sweepSessionsOnLostRunners", () => {
  it("runs its first pass at once, and passes only the connected runners to the rule", async () => {
    const passes: Array<ReadonlyArray<string>> = [];
    const recording = Layer.succeed(SessionService, {
      endOnLostRunners: (connected: ReadonlyArray<string>) =>
        Effect.sync(() => {
          passes.push(connected);
        }),
    } as unknown as SessionService["Service"]);

    const { online } = await Effect.runPromise(
      Effect.gen(function* () {
        const online = yield* insertRunner("online");
        yield* insertRunner("unreachable");
        // The default interval is a minute, so no second pass runs during this
        // test: the call seen is the first pass.
        const sweeping = yield* Effect.forkChild(sweepSessionsOnLostRunners);
        while (passes.length === 0) yield* Effect.yieldNow;
        yield* Fiber.interrupt(sweeping);
        return { online };
      }).pipe(Effect.provide(Layer.merge(recording, TestDatabase)), Effect.orDie),
    );

    expect(passes).toEqual([[online]]);
  });
});
