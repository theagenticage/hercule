/**
 * Tests the sweep around `SessionService.endOnLostRunners`: what it passes to
 * the rule, when the first pass runs, and that the agent steps of the ended
 * sessions fail. The rule itself is tested with the sessions service.
 *
 * The services are stubs that record each call, because these tests only
 * check what the sweep calls and when.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mintUuid, uuidToString } from "../../db";
import { TestDatabase } from "../../db/testing";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import { RunService } from "../../runs";
import { SessionService } from "../../sessions";
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
  it("runs its first pass at once, passes only the connected runners to the rule, and fails the ended sessions' steps", async () => {
    const ended = [{ id: "an-ended-session", runId: "a-run" }];
    const passes: Array<ReadonlyArray<string>> = [];
    const failedSteps: Array<{ ended: ReadonlyArray<unknown>; message: string }> = [];
    const recording = Layer.merge(
      Layer.succeed(SessionService, {
        endOnLostRunners: (connected: ReadonlyArray<string>) =>
          Effect.sync(() => {
            passes.push(connected);
            return ended;
          }),
      } as unknown as SessionService["Service"]),
      Layer.succeed(RunService, {
        failStepsOfEndedSessions: (sessions: ReadonlyArray<unknown>, message: string) =>
          Effect.sync(() => {
            failedSteps.push({ ended: sessions, message });
          }),
      } as unknown as RunService["Service"]),
    );

    const { online } = await Effect.runPromise(
      Effect.gen(function* () {
        const online = yield* insertRunner("online");
        yield* insertRunner("unreachable");
        // The default interval is a minute, so no second pass runs during this
        // test: the call seen is the first pass.
        const sweeping = yield* Effect.forkChild(sweepSessionsOnLostRunners);
        while (failedSteps.length === 0) yield* Effect.yieldNow;
        yield* Fiber.interrupt(sweeping);
        return { online };
      }).pipe(
        Effect.provide(
          Layer.merge(recording, ServingPromotionStateLayer.pipe(Layer.provideMerge(TestDatabase))),
        ),
        Effect.orDie,
      ),
    );

    expect(passes).toEqual([[online]]);
    expect(failedSteps).toEqual([
      {
        ended,
        message:
          "The step's session ended because its runner was not heard from for longer than the session's absolute timeout.",
      },
    ]);
  });
});
