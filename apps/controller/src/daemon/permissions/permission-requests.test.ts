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
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../../db";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../../events";
import { NotifierLayer } from "../../notifications";
import {
  permissionRequestRepository,
  PermissionProfiles,
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
      withTransaction(
        sql,
        sql`
        INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
        VALUES (${uuidFromString(id)}, ${name}, '["task.read"]', 0, ${AT}, ${AT})`,
      ),
      id,
    );
  });

/** Inserts a session on `profileId` with the given status and returns its id. */
const insertSession = (profileId: string, status: "idle" | "exited") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const id = mintId();
    const profile = uuidFromString(profileId);
    return Effect.as(
      withTransaction(
        sql,
        sql`
        INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                              requested_access_mode, access_mode, spec, title, status,
                              created_at, last_activity_at)
        VALUES (${uuidFromString(id)}, ${profile}, ${profile}, ${profile}, 'auto', 'auto', '{}',
                'a session', ${status}, ${AT}, ${AT})`,
      ),
      id,
    );
  });

/** Stores an open request of the session for `grant`, asked under `profileId`. */
const insertOpenRequest = (sessionId: string, profileId: string, grant: Grant = "task.delete") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const requests = yield* permissionRequestRepository;
    return yield* withTransaction(
      sql,
      requests.insert({
        sessionId,
        profileId,
        grant,
        reason: "a reason",
        operation: undefined,
        at: AT,
      }),
    );
  });

/** Builds the actor of a session on `profileId` holding `grants`, by default only `task.read`. */
const buildSessionActor = (
  sessionId: string,
  profileId: string,
  grants: ReadonlyArray<Grant> = ["task.read"],
): Actor => {
  return {
    _tag: "session",
    sessionId,
    profileId,
    grants,
    profileGrants: grants,
    assistantId: null,
    agentId: null,
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

  it("refuses a grant decided with outcome session after the caller's grants were read", async () => {
    const refusal = await run(
      Effect.gen(function* () {
        const profileId = yield* insertProfile("worker");
        const sessionId = yield* insertSession(profileId, "idle");
        const requestId = yield* insertOpenRequest(sessionId, profileId);
        yield* decide(requestId, "session");
        // The actor still lacks task.delete, as it would for a second call
        // authenticated before the first request was decided.
        const use = yield* PermissionRequests;
        return yield* readRefusal(
          use
            .request({ grant: "task.delete", reason: "a reason" })
            .pipe(Effect.provideService(CurrentActor, buildSessionActor(sessionId, profileId))),
        );
      }),
    );

    expect(refusal.code).toBe("invalid_state");
    expect(refusal.message).toMatch(/already holds task\.delete; retry the call/);
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

describe("permission.decide on a request for skill.write or skill.apply", () => {
  /** A deciding session's grants: the shipped `unrestricted` profile holds `permission.write`. */
  const DECIDER_GRANTS: ReadonlyArray<Grant> = ["permission.read", "permission.write"];

  it("refuses a session every outcome, naming permission.write, and leaves the request open", async () => {
    const result = await run(
      Effect.gen(function* () {
        const profileId = yield* insertProfile("worker");
        const sessionId = yield* insertSession(profileId, "idle");
        const decider = buildSessionActor(
          yield* insertSession(profileId, "idle"),
          profileId,
          DECIDER_GRANTS,
        );
        const requests = yield* permissionRequestRepository;
        const refusals: Array<unknown> = [];
        const statuses: Array<string> = [];
        for (const grant of ["skill.write", "skill.apply"] as const) {
          const requestId = yield* insertOpenRequest(sessionId, profileId, grant);
          for (const outcome of ["session", "profile", "deny"] as const) {
            refusals.push(
              yield* Effect.flip(
                decide(requestId, outcome).pipe(Effect.provideService(CurrentActor, decider)),
              ),
            );
          }
          statuses.push(Option.getOrThrow(yield* requests.read(requestId)).status);
        }
        return { refusals, statuses };
      }),
    );

    expect(result.statuses).toEqual(["open", "open"]);
    expect(result.refusals).toHaveLength(6);
    for (const refusal of result.refusals) {
      expect(refusal).toMatchObject({
        error: {
          code: "forbidden",
          details: { grant: "permission.write" },
          message: expect.stringMatching(
            /^Only the user gives a profile `skill\.write`/,
          ) as unknown,
        },
      });
    }
  });

  it("lets a session decide a request for any other grant", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const profileId = yield* insertProfile("worker");
        const sessionId = yield* insertSession(profileId, "idle");
        const decider = buildSessionActor(
          yield* insertSession(profileId, "idle"),
          profileId,
          DECIDER_GRANTS,
        );
        const requestId = yield* insertOpenRequest(sessionId, profileId);
        yield* decide(requestId, "deny").pipe(Effect.provideService(CurrentActor, decider));
        const requests = yield* permissionRequestRepository;
        return Option.getOrThrow(yield* requests.read(requestId)).outcome;
      }),
    );

    expect(outcome).toBe("deny");
  });

  it("lets the user give skill.apply to the session's profile", async () => {
    const grants = await run(
      Effect.gen(function* () {
        const profileId = yield* insertProfile("worker");
        const sessionId = yield* insertSession(profileId, "idle");
        const requestId = yield* insertOpenRequest(sessionId, profileId, "skill.apply");
        yield* decide(requestId, "profile");
        const profiles = yield* PermissionProfiles;
        return Option.getOrThrow(yield* profiles.getById(profileId)).grants;
      }),
    );

    expect(grants).toEqual(["task.read", "skill.apply"]);
  });
});
