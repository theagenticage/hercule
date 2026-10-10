/**
 * Tests the refusals of the Permission Request use case that HTTP cannot
 * reach: a session that ended, and a session that moved to another profile,
 * while its request was open.
 *
 * Over HTTP neither state arises. An exited session's token no longer
 * resolves, ending a session withdraws its open requests in the same
 * transaction, and a session only changes profile on a resume, after that
 * exit. These checks guard against a session ending between the token check
 * and the use case's transaction, and against a future path that breaks those
 * rules. So the rows are written directly here, and the use case is called
 * in-process.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Grant } from "@hercule/contract";
import { CurrentActor, type Actor } from "../../actor";
import { mintUuid, uuidFromString, uuidToString } from "../../db";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../../events";
import { NotifierLayer } from "../../notifications";
import {
  permissionRequestRepository,
  PermissionProfilesLayer,
  ProfilesLayer,
  SessionTokensLayer,
} from "../../permissions";
import { PermissionRequests, PermissionRequestsLayer } from "./permission-requests";

const layer = PermissionRequestsLayer.pipe(
  Layer.provideMerge(ProfilesLayer),
  Layer.provideMerge(
    Layer.mergeAll(PermissionProfilesLayer, SessionTokensLayer, PlatformEventsLayer),
  ),
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

type Deps = Layer.Success<typeof layer>;

const AT = "2026-09-15T10:00:00.000Z";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/**
 * Runs the test body in a new database, as the user. The body runs a call as
 * a session with `asSession`.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)));

/** Runs `effect` as the session, expecting a refusal, and returns its code and message. */
const readRefusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(
    Effect.flip(effect),
    (error) => (error as { readonly error: { code: string; message: string } }).error,
  );

/** Inserts a profile holding `task.read` and returns its id. */
const insertProfile = (name: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const id = mintId();
    return Effect.as(
      sql`
        INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
        VALUES (${uuidFromString(id)}, ${name}, '["task.read"]', 0, ${AT}, ${AT})`,
      id,
    );
  });

/** Inserts a session on `profileId` with the given status and returns its id. */
const insertSession = (profileId: string, status: "idle" | "exited") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const id = mintId();
    const profile = uuidFromString(profileId);
    return Effect.as(
      sql`
        INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                              requested_access_mode, access_mode, spec, title, status,
                              created_at, last_activity_at)
        VALUES (${uuidFromString(id)}, ${profile}, ${profile}, ${profile}, 'auto', 'auto', '{}',
                'a session', ${status}, ${AT}, ${AT})`,
      id,
    );
  });

/** Stores an open request of the session for `task.delete`, asked under `profileId`. */
const insertOpenRequest = (sessionId: string, profileId: string) =>
  Effect.flatMap(permissionRequestRepository, (requests) =>
    requests.insert({
      sessionId,
      profileId,
      grant: "task.delete",
      reason: "a reason",
      operation: undefined,
      at: AT,
    }),
  );

/** Builds the actor of a session on `profileId` holding only `task.read`. */
const buildSessionActor = (sessionId: string, profileId: string): Actor => {
  const grants: ReadonlyArray<Grant> = ["task.read"];
  return {
    _tag: "session",
    sessionId,
    profileId,
    grants,
    profileGrants: grants,
    assistantId: null,
  };
};

const decide = (requestId: string, outcome: "session" | "profile" | "deny") =>
  Effect.flatMap(PermissionRequests, (use) => use.decide({ requestId, outcome }));

describe("permission.request", () => {
  it("refuses a session that exited after its token was resolved", async () => {
    const refusal = await run(
      Effect.gen(function* () {
        const profileId = yield* insertProfile("worker");
        const sessionId = yield* insertSession(profileId, "exited");
        const use = yield* PermissionRequests;
        return yield* readRefusal(
          use
            .request({ grant: "task.delete", reason: "a reason" })
            .pipe(Effect.provideService(CurrentActor, buildSessionActor(sessionId, profileId))),
        );
      }),
    );

    expect(refusal.code).toBe("invalid_state");
    expect(refusal.message).toMatch(/has ended, so it can neither ask for a grant/);
  });
});

describe("permission.decide", () => {
  it("refuses every outcome for a session that has exited", async () => {
    const refusals = await run(
      Effect.gen(function* () {
        const profileId = yield* insertProfile("worker");
        const sessionId = yield* insertSession(profileId, "exited");
        const requestId = yield* insertOpenRequest(sessionId, profileId);
        return [
          yield* readRefusal(decide(requestId, "session")),
          yield* readRefusal(decide(requestId, "profile")),
          yield* readRefusal(decide(requestId, "deny")),
        ];
      }),
    );

    for (const refusal of refusals) {
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toMatch(/has ended/);
    }
  });

  it("refuses session and profile once the session moved to another profile, and allows deny", async () => {
    const result = await run(
      Effect.gen(function* () {
        const askedUnder = yield* insertProfile("worker");
        const current = yield* insertProfile("reviewer");
        const sessionId = yield* insertSession(current, "idle");
        const requestId = yield* insertOpenRequest(sessionId, askedUnder);
        const refusals = [
          yield* readRefusal(decide(requestId, "session")),
          yield* readRefusal(decide(requestId, "profile")),
        ];
        yield* decide(requestId, "deny");
        const requests = yield* permissionRequestRepository;
        const stored = yield* requests.read(requestId);
        return { refusals, outcome: Option.getOrThrow(stored).outcome };
      }),
    );

    for (const refusal of result.refusals) {
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toMatch(/moved to another permission profile/);
    }
    expect(result.outcome).toBe("deny");
  });
});
