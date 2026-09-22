/**
 * The clock around `SessionService.endOnLostRunners`: what it hands the rule,
 * and when the first pass runs. The rule itself is tested through the
 * sessions service.
 *
 * The service is a stand-in that records each call, because the question here
 * is only what the clock asks for and when.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { SessionService } from "../sessions";
import { sweepSessionsOnLostRunners } from "./lost-runners";

const at = "2026-09-22T10:00:00.000Z";

/** A runner row at this connectivity, which is all the clock reads about a runner. */
const aRunner = (connectivity: "online" | "unreachable") =>
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
  it("runs its first pass at once, and hands the rule the connected runners only", async () => {
    const passes: Array<ReadonlyArray<string>> = [];
    const recording = Layer.succeed(SessionService, {
      endOnLostRunners: (connected: ReadonlyArray<string>) =>
        Effect.sync(() => {
          passes.push(connected);
        }),
    } as unknown as SessionService["Service"]);

    const { online } = await Effect.runPromise(
      Effect.gen(function* () {
        const online = yield* aRunner("online");
        yield* aRunner("unreachable");
        // The shipped interval is a minute, so a second pass cannot run in
        // this test: what is seen is the pass at start.
        const sweeping = yield* Effect.forkChild(sweepSessionsOnLostRunners);
        while (passes.length === 0) yield* Effect.yieldNow;
        yield* Fiber.interrupt(sweeping);
        return { online };
      }).pipe(Effect.provide(Layer.merge(recording, TestDatabase)), Effect.orDie),
    );

    expect(passes).toEqual([[online]]);
  });
});
