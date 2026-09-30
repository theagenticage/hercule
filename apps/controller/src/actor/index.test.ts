import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { ALL_OPERATIONS, readRequirement } from "@hercule/contract";
import {
  CurrentActor,
  currentStamp,
  checkGrant,
  buildActorStamp,
  requireUserActor,
  type Actor,
} from ".";

const user: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "abc" },
};

const nobody: Actor = { _tag: "none" };

const RUN_ID = "0199f0b7-0004-7000-8000-000000000000";

/** A run while its step `file_task` executes. */
const run: Actor = { _tag: "run", runId: RUN_ID, stepId: "file_task", workflowId: null };

const SESSION_ID = "0199f0b7-0002-7000-8000-000000000000";

/** A session on a profile that reads and creates tasks, and nothing else. */
const agent: Actor = {
  _tag: "session",
  sessionId: SESSION_ID,
  profileId: "0199f0b7-0003-7000-8000-000000000000",
  grants: ["task.read", "task.create", "session.spawn"],
  assistantId: null,
};

/**
 * Returns the grant in the `Forbidden` error, or `undefined` when the check let
 * the caller through.
 */
const readMissingGrant = (refused: ReturnType<typeof checkGrant>): string | undefined =>
  refused?.error.details.grant;

describe("buildActorStamp", () => {
  it("is the bare word for the user, whatever credential it presented", () => {
    expect(buildActorStamp(user)).toBe("user");
  });

  it("is session:<id> for a session, so a reader can trace a change back to it", () => {
    expect(buildActorStamp(agent)).toBe(`session:${SESSION_ID}`);
  });

  it("is run:<id> for a run, whichever of its steps is executing", () => {
    expect(buildActorStamp(run)).toBe(`run:${RUN_ID}`);
  });
});

describe("currentStamp", () => {
  it("returns the stamp of the actor the request resolved", async () => {
    const stamps = await Effect.runPromise(
      Effect.all([
        Effect.provideService(currentStamp, CurrentActor, user),
        Effect.provideService(currentStamp, CurrentActor, agent),
      ]),
    );

    expect(stamps).toEqual(["user", `session:${SESSION_ID}`]);
  });

  it("dies when there is no actor, rather than attributing the write to the user", async () => {
    await expect(Effect.runPromise(currentStamp)).rejects.toThrow(
      "a write reached stamping with no authenticated actor behind it",
    );
  });
});

describe("checkGrant", () => {
  it("lets the user actor call every operation", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(checkGrant(operation.id, user)).toBeUndefined();
    }
  });

  it("lets a run call every operation, because its steps act for the user", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(checkGrant(operation.id, run)).toBeUndefined();
    }
  });

  it("checks nothing when the operation requires only a valid credential", () => {
    expect(readRequirement("apiKey.query")).toBe("credential.read");
    expect(checkGrant("auth.wsTicket", nobody)).toBeUndefined();
  });

  it("reports the grant that a caller with no actor is missing", () => {
    expect(readMissingGrant(checkGrant("secret.set", nobody))).toBe("secret.write");
  });

  it("lets a session through exactly the grants its profile holds", () => {
    expect(checkGrant("task.create", agent)).toBeUndefined();
    expect(readMissingGrant(checkGrant("task.delete", agent))).toBe("task.delete");
  });

  it("lets a session spawn, because only the payload shows whether a spawn is a Thread", () => {
    // Any actor may spawn from an Agent, but only the user may start a Thread.
    // This check runs before the payload is decoded, so placement is where the
    // two are told apart.
    expect(checkGrant("session.spawn", agent)).toBeUndefined();
  });

  it("lets that same session continue one, on the same grant", () => {
    expect(readRequirement("session.continue")).toBe("session.spawn");
    expect(checkGrant("session.continue", agent)).toBeUndefined();
  });
});

describe("requireUserActor", () => {
  /** Runs `requireUserActor` for `notification.act` as `actor` and returns the error, if any. */
  const readRefusal = (actor: Actor, refusal?: string) =>
    Effect.runPromise(
      Effect.flip(requireUserActor("notification.act", refusal)).pipe(
        Effect.provideService(CurrentActor, actor),
        Effect.orElseSucceed(() => undefined),
      ),
    );

  it("returns the user actor", async () => {
    await expect(
      Effect.runPromise(
        Effect.provideService(requireUserActor("notification.act"), CurrentActor, user),
      ),
    ).resolves.toBe(user);
  });

  it("refuses a run, although a run passes every grant check", async () => {
    const refused = await readRefusal(run);
    expect(refused?.error.code).toBe("forbidden");
    expect(refused?.error.message).toMatch(/only the user/);
  });

  it("refuses a session with the message the operation passes", async () => {
    const refused = await readRefusal(
      { ...agent, grants: ["notification.write"] },
      "ask the user instead",
    );
    expect(refused?.error).toEqual({
      code: "forbidden",
      message: "ask the user instead",
      details: { grant: "notification.write" },
    });
  });
});
