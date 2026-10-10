/**
 * Tests the timing of the sweep that reports unreachable runners: it waits out
 * the grace after the controller starts before its first check, so a restart
 * does not report runners that were only waiting for the controller to come
 * back. The rule each check applies is tested in `runners/connections.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { hashToken } from "../../credentials";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer } from "../../events";
import { NotifierLayer } from "../../notifications";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import { RunnerConnectionsLayer, runnerRepository } from "../../runners";
import { sweepUnreachableRunners } from "./unreachable-runners";

const layer = RunnerConnectionsLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(ServingPromotionStateLayer),
  Layer.provideMerge(TestDatabase),
);

const START = Date.parse("2026-09-01T12:00:00.000Z");

describe("sweepUnreachableRunners", () => {
  it("reports a runner the controller found unreachable at boot only after the grace has passed", async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const sql = yield* SqlClient.SqlClient;
        const runners = yield* runnerRepository;
        // Last seen an hour before the controller started: long past the
        // grace by its own clock, but the controller has only just come up.
        const anHourBefore = new Date(START - 60 * 60_000).toISOString();
        const laptop = yield* runners.insert({
          name: "laptop",
          connectivity: "unreachable",
          lifecycle: "active",
          reserved: false,
          labels: [],
          credentialHash: hashToken(crypto.randomUUID()),
          at: anHourBefore,
        });
        yield* runners.touch(laptop.id, anHourBefore);
        const countNotifications = Effect.map(
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM notifications`,
          (rows) => rows[0]?.count ?? 0,
        );

        const sweep = yield* Effect.forkChild(sweepUnreachableRunners);
        yield* TestClock.adjust(Duration.seconds(119));
        const withinTheGrace = yield* countNotifications;
        yield* TestClock.adjust(Duration.seconds(1));
        const afterTheGrace = yield* countNotifications;
        yield* TestClock.adjust(Duration.minutes(5));
        const later = yield* countNotifications;
        yield* Fiber.interrupt(sweep);
        return { withinTheGrace, afterTheGrace, later };
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.orDie),
    );

    expect(counts).toEqual({ withinTheGrace: 0, afterTheGrace: 1, later: 1 });
  });
});
