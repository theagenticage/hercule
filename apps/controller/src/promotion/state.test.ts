import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SYSTEM_ACTOR } from "../actor";
import { AfterCommit } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { ControllerIdentity } from "../identity";
import { PromotionDrainTimeout, PromotionState, PromotionStateLayer } from "./state";

const TOKEN = "0199f0b7-0000-7000-8000-00000000aaaa";
const OTHER_TOKEN = "0199f0b7-0000-7000-8000-00000000bbbb";
const NEW_ADDRESS = "http://b.test:4937";

/**
 * The state's dependencies, with an identity whose signature is a fixed run
 * of bytes: these tests check the gate, not the key.
 */
const StateDependencies = Layer.mergeAll(
  Layer.succeed(ControllerIdentity, {
    ensure: Effect.die("not used"),
    readOrDie: Effect.die("not used"),
    sign: () => Effect.succeed(new Uint8Array(64).fill(7)),
  }),
  AuditLogLayer,
);

/** Returns a deadline far enough away that no test reaches it. */
const inAnHour = (): Date => new Date(Date.now() + 3_600_000);

/**
 * Runs `body` against a fresh promotion state over an in-memory database, with
 * a drain timeout short enough for a test to wait out.
 */
const run = <A, E>(
  body: Effect.Effect<A, E, PromotionState | SqlClient.SqlClient | AuditLog>,
): Promise<A> =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(PromotionStateLayer.pipe(Layer.provideMerge(StateDependencies))),
      Effect.provide(TestDatabase),
      Effect.provideService(PromotionDrainTimeout, Duration.millis(100)),
    ),
  );

/**
 * Returns the API error code `effect` fails with. Dies when `effect` succeeds
 * or fails with an error that has no code, so the test fails loudly.
 */
const readErrorCode = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R> =>
  Effect.flatMap(Effect.orDie(Effect.flip(effect)), (error) =>
    typeof error === "object" && error !== null && "error" in error
      ? Effect.succeed((error as { readonly error: { readonly code: string } }).error.code)
      : Effect.die(error),
  );

/** Lets forked fibers run until they block. */
const settle = Effect.sleep(Duration.millis(20));

/**
 * Writes one audit entry, as any writer of the controller might, and returns
 * "written", or the SQLite error the database refused it with.
 */
const tryWrite: Effect.Effect<string, never, AuditLog> = Effect.flatMap(AuditLog, (audit) =>
  audit
    .append({
      kind: "controller.promotion.cancelled",
      actor: SYSTEM_ACTOR,
      payload: { promotionTokenId: TOKEN },
    })
    .pipe(
      Effect.as("written"),
      Effect.catchTag("SqlError", (error) => Effect.succeed(String(error.reason.cause))),
    ),
);

/** Counts the rows of `sealed_state`: 1 once a seal is stored, 0 before. */
const countStoredSeals = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM sealed_state`,
    (rows) => rows[0]?.n ?? 0,
  ),
);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-promotion-state-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("PromotionState", () => {
  it("admits requests while serving, refuses them while frozen, and once sealed", async () => {
    const codes = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const serving = yield* state.admit(Effect.succeed("ran"));
        yield* state.freeze(TOKEN, inAnHour());
        const frozen = yield* readErrorCode(state.admit(Effect.void));
        yield* state.seal(TOKEN, NEW_ADDRESS);
        const sealed = yield* readErrorCode(state.admit(Effect.void));
        return { serving, frozen, sealed };
      }),
    );
    expect(codes).toEqual({
      serving: "ran",
      frozen: "promotion_in_progress",
      sealed: "controller_sealed",
    });
  });

  it("starts a freeze only after the admitted work that was running has finished", async () => {
    const order = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const order: Array<string> = [];
        const release = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          state.admit(
            Effect.andThen(
              Deferred.await(release),
              Effect.sync(() => order.push("request")),
            ),
          ),
        );
        yield* settle;
        const freeze = yield* Effect.forkChild(
          Effect.andThen(
            state.freeze(TOKEN, inAnHour()),
            Effect.sync(() => order.push("frozen")),
          ),
        );
        yield* settle;
        order.push("released");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(request);
        yield* Fiber.join(freeze);
        return order;
      }),
    );
    expect(order).toEqual(["released", "request", "frozen"]);
  });

  it("thaws and fails a freeze whose running work does not finish in time", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* Effect.forkChild(state.admit(Effect.never));
        yield* settle;
        const code = yield* readErrorCode(state.freeze(TOKEN, inAnHour()));
        const phase = yield* state.phase;
        return { code, phase: phase._tag };
      }),
    );
    expect(outcome).toEqual({ code: "invalid_state", phase: "Serving" });
  });

  it("runs work started inside admitted work while a freeze waits for the outer work", async () => {
    const ran = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const release = yield* Deferred.make<void>();
        const request = yield* Effect.forkChild(
          state.admit(
            Effect.andThen(Deferred.await(release), state.whenServing(Effect.succeed("inner"))),
          ),
        );
        yield* settle;
        const freeze = yield* Effect.forkChild(state.freeze(TOKEN, inAnHour()));
        yield* settle;
        yield* Deferred.succeed(release, undefined);
        const inner = yield* Fiber.join(request);
        yield* Fiber.join(freeze);
        return inner;
      }),
    );
    expect(ran).toBe("inner");
  });

  it("holds work a fiber starts after the admitted work it was forked in has ended", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const release = yield* Deferred.make<void>();
        let ran = false;
        const forked = yield* state.admit(
          Effect.forkDetach(
            Effect.andThen(
              Deferred.await(release),
              state.whenServing(Effect.sync(() => (ran = true))),
            ),
          ),
        );
        yield* state.freeze(TOKEN, inAnHour());
        yield* Deferred.succeed(release, undefined);
        yield* settle;
        const whileFrozen = ran;
        yield* state.thaw(TOKEN);
        yield* Fiber.join(forked);
        return { whileFrozen, afterThaw: ran };
      }),
    );
    expect(seen).toEqual({ whileFrozen: false, afterThaw: true });
  });

  it("starts a freeze only after work forked inside admitted work has finished", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* state.admit(
          Effect.andThen(
            Effect.forkDetach(
              state.whenServing(
                Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release)),
              ),
            ),
            Deferred.await(started),
          ),
        );
        const freeze = yield* Effect.forkChild(state.freeze(TOKEN, inAnHour()));
        yield* settle;
        const frozenEarly = freeze.pollUnsafe() !== undefined;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(freeze);
        return { frozenEarly, phase: (yield* state.phase)._tag };
      }),
    );
    expect(seen).toEqual({ frozenEarly: false, phase: "Frozen" });
  });

  it("holds background work while frozen and runs it after the thaw", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* state.freeze(TOKEN, inAnHour());
        let ran = false;
        const background = yield* Effect.forkChild(
          state.whenServing(Effect.sync(() => (ran = true))),
        );
        yield* settle;
        const whileFrozen = ran;
        yield* state.thaw(TOKEN);
        yield* Fiber.join(background);
        return { whileFrozen, afterThaw: ran };
      }),
    );
    expect(seen).toEqual({ whileFrozen: false, afterThaw: true });
  });

  it("refuses every write from the copy until the thaw, and allows writes after it", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* state.freeze(TOKEN, inAnHour());
        const beforeCopy = yield* tryWrite;
        yield* state.copyDatabaseAndStopWrites(TOKEN, join(scratch, "copy.db"));
        const afterCopy = yield* tryWrite;
        yield* state.thaw(TOKEN);
        const afterThaw = yield* tryWrite;
        return { beforeCopy, afterCopy, afterThaw };
      }),
    );
    expect(outcome.beforeCopy).toBe("written");
    expect(outcome.afterCopy).toContain("readonly");
    expect(outcome.afterThaw).toBe("written");
  });

  it("refuses to copy once the freeze has ended, and leaves writes allowed", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* state.freeze(TOKEN, inAnHour());
        yield* state.thaw(TOKEN);
        const code = yield* readErrorCode(
          state.copyDatabaseAndStopWrites(TOKEN, join(scratch, "copy.db")),
        );
        return { code, write: yield* tryWrite };
      }),
    );
    expect(outcome).toEqual({ code: "invalid_state", write: "written" });
  });

  it("writes the seal while writes are stopped, and refuses every write after it", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* state.freeze(TOKEN, inAnHour());
        yield* state.copyDatabaseAndStopWrites(TOKEN, join(scratch, "copy.db"));
        yield* state.seal(TOKEN, NEW_ADDRESS);
        return { seals: yield* countStoredSeals, write: yield* tryWrite };
      }),
    );
    expect(outcome.seals).toBe(1);
    expect(outcome.write).toContain("readonly");
  });

  it("is sealed in memory whenever the seal is stored, even if the seal is interrupted", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* state.freeze(TOKEN, inAnHour());
        // The announcement of the seal's audit entry runs right after the
        // commit, so interrupting the seal then aims at the moment between
        // the stored seal and the sealed phase.
        const committed = yield* Deferred.make<void>();
        const seal = yield* Effect.forkChild(
          state.seal(TOKEN, NEW_ADDRESS).pipe(
            Effect.provideService(AfterCommit, {
              publish: () => Effect.andThen(Deferred.succeed(committed, undefined), settle),
            }),
          ),
        );
        yield* Deferred.await(committed);
        yield* Fiber.interrupt(seal);
        return { seals: yield* countStoredSeals, phase: (yield* state.phase)._tag };
      }),
    );
    expect(outcome).toEqual({ seals: 1, phase: "Sealed" });
  });

  it("refuses a second freeze, and a thaw for another token", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        yield* state.freeze(TOKEN, inAnHour());
        const second = yield* readErrorCode(state.freeze(OTHER_TOKEN, inAnHour()));
        yield* state.thaw(OTHER_TOKEN);
        return { second, phase: (yield* state.phase)._tag };
      }),
    );
    expect(outcome).toEqual({ second: "promotion_in_progress", phase: "Frozen" });
  });

  it("seals only for the token it is frozen for, seals once, and cannot thaw after", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const state = yield* PromotionState;
        const unfrozen = yield* readErrorCode(state.seal(TOKEN, NEW_ADDRESS));
        yield* state.freeze(TOKEN, inAnHour());
        const otherToken = yield* readErrorCode(state.seal(OTHER_TOKEN, NEW_ADDRESS));
        const first = yield* state.seal(TOKEN, NEW_ADDRESS);
        const again = yield* state.seal(TOKEN, NEW_ADDRESS);
        const afterSeal = yield* readErrorCode(state.seal(OTHER_TOKEN, NEW_ADDRESS));
        const thawAfterSeal = yield* readErrorCode(state.thaw(TOKEN));
        return { unfrozen, otherToken, same: again === first, afterSeal, thawAfterSeal };
      }),
    );
    expect(outcome).toEqual({
      unfrozen: "invalid_state",
      otherToken: "invalid_state",
      same: true,
      afterSeal: "controller_sealed",
      thawAfterSeal: "controller_sealed",
    });
  });

  it("restores the seal after a restart, deletes it with forceUnseal, and audits both", async () => {
    const phases = await run(
      Effect.gen(function* () {
        const before = yield* PromotionState;
        yield* before.freeze(TOKEN, inAnHour());
        yield* before.seal(TOKEN, NEW_ADDRESS);
        // A restarted controller opens a new connection, which accepts writes
        // again. This test keeps the one connection, so it allows them itself.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA query_only = OFF`;
        // A second state over the same database stands in for the restarted controller.
        const restart = (forceUnseal: boolean) =>
          Effect.gen(function* () {
            const after = yield* PromotionState;
            yield* after.restore({ forceUnseal });
            return (yield* after.phase)._tag;
          }).pipe(
            Effect.provide(Layer.fresh(PromotionStateLayer.pipe(Layer.provide(StateDependencies)))),
          );
        const restored = yield* restart(false);
        const unsealed = yield* restart(true);
        const afterUnseal = yield* restart(false);
        const audited = yield* sql<{ readonly kind: string }>`
          SELECT kind FROM events WHERE kind LIKE 'controller.%' ORDER BY id
        `;
        return { restored, unsealed, afterUnseal, audited: audited.map((row) => row.kind) };
      }),
    );
    expect(phases).toEqual({
      restored: "Sealed",
      unsealed: "Serving",
      afterUnseal: "Serving",
      audited: ["controller.sealed", "controller.unsealed"],
    });
  });
});
