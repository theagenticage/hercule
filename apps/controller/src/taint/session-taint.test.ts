import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { sessionTaint } from "./index";

const AT = "2026-11-01T00:00:00.000Z";

const asSession = (sessionId: string): Actor => ({
  _tag: "session",
  sessionId,
  profileId: uuidToString(mintUuid()),
  grants: [],
  profileGrants: [],
  assistantId: null,
  agentId: null,
});

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const RUN: Actor = {
  _tag: "run",
  runId: "0199f0b7-0000-7000-8000-0000000000aa",
  stepId: "step",
  workflowId: null,
};

const NO_ACTOR: Actor = { _tag: "none" };

/** Runs a test body over a fresh database, with the taint functions built. */
const run = <A>(
  body: (
    taint: Effect.Success<typeof sessionTaint>,
    addSession: () => Effect.Effect<string, unknown, SqlClient.SqlClient>,
  ) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const taint = yield* sessionTaint;
      const addSession = () =>
        Effect.flatMap(SqlClient.SqlClient, (sql) => {
          const id = mintUuid();
          const none = mintUuid();
          return sql`
            INSERT INTO sessions (id, permission_profile_id, provider_account_id, harness_id,
                                  runner_id, requested_access_mode, access_mode, spec, title,
                                  status, created_at, last_activity_at)
            VALUES (${id}, ${none}, ${none}, 'test.harness', ${none}, 'auto', 'auto', '{}',
                    'a session', 'idle', ${AT}, ${AT})
          `.pipe(Effect.as(uuidToString(id)));
        });
      return yield* body(taint, () => inTransaction(addSession()));
    }).pipe(Effect.provide(TestDatabase), Effect.scoped),
  );

/** Reads whether a session is tainted, as a caller who is that session. */
const isTainted = (taint: Effect.Success<typeof sessionTaint>, sessionId: string) =>
  taint.isCallerTainted.pipe(Effect.provideService(CurrentActor, asSession(sessionId)));

const asActor = <A, E, R>(actor: Actor, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentActor, actor);

describe("sessionTaint", () => {
  it("starts a session clean", () =>
    run((taint, addSession) =>
      Effect.gen(function* () {
        const id = yield* addSession();
        expect(yield* isTainted(taint, id)).toBe(false);
      }),
    ));

  it("marks a session tainted, and marking again changes nothing", () =>
    run((taint, addSession) =>
      Effect.gen(function* () {
        const id = yield* addSession();
        const other = yield* addSession();
        yield* inTransaction(taint.markTainted(id));
        yield* inTransaction(taint.markTainted(id));
        expect(yield* isTainted(taint, id)).toBe(true);
        expect(yield* isTainted(taint, other)).toBe(false);
      }),
    ));

  it("reports an untainted caller for the user, a run and no actor", () =>
    run((taint) =>
      Effect.gen(function* () {
        for (const actor of [USER, RUN, NO_ACTOR]) {
          expect(yield* asActor(actor, taint.isCallerTainted)).toBe(false);
        }
      }),
    ));

  it("reports an untainted caller for a session whose row does not exist", () =>
    run((taint) =>
      Effect.gen(function* () {
        expect(yield* isTainted(taint, uuidToString(mintUuid()))).toBe(false);
      }),
    ));

  it("taints a session when the caller is a tainted session", () =>
    run((taint, addSession) =>
      Effect.gen(function* () {
        const caller = yield* addSession();
        const target = yield* addSession();
        yield* inTransaction(taint.markTainted(caller));
        yield* inTransaction(asActor(asSession(caller), taint.passOn(target)));
        expect(yield* isTainted(taint, target)).toBe(true);
      }),
    ));

  it("taints a session whose parent is tainted, whoever the caller is", () =>
    run((taint, addSession) =>
      Effect.gen(function* () {
        const parent = yield* addSession();
        const fork = yield* addSession();
        yield* inTransaction(taint.markTainted(parent));
        yield* inTransaction(asActor(USER, taint.passOn(fork, parent)));
        expect(yield* isTainted(taint, fork)).toBe(true);
      }),
    ));

  it("leaves a session clean when neither the caller nor the parent is tainted", () =>
    run((taint, addSession) =>
      Effect.gen(function* () {
        const caller = yield* addSession();
        const parent = yield* addSession();
        const target = yield* addSession();
        const tainted = yield* addSession();
        yield* inTransaction(taint.markTainted(tainted));
        yield* inTransaction(asActor(asSession(caller), taint.passOn(target, parent)));
        yield* inTransaction(asActor(USER, taint.passOn(target)));
        yield* inTransaction(asActor(NO_ACTOR, taint.passOn(target)));
        expect(yield* isTainted(taint, target)).toBe(false);
      }),
    ));

  it("never clears the flag of a tainted session", () =>
    run((taint, addSession) =>
      Effect.gen(function* () {
        const clean = yield* addSession();
        const target = yield* addSession();
        yield* inTransaction(taint.markTainted(target));
        yield* inTransaction(asActor(asSession(clean), taint.passOn(target, clean)));
        expect(yield* isTainted(taint, target)).toBe(true);
      }),
    ));
});
