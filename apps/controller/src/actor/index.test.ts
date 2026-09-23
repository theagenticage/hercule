import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { ALL_OPERATIONS, readRequirement } from "@hercule/contract";
import { CurrentActor, currentStamp, checkGrant, buildActorStamp, type Actor } from ".";

const user: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "abc" },
};

const nobody: Actor = { _tag: "none" };

const SESSION_ID = "0199f0b7-0002-7000-8000-000000000000";

/** A session on a profile that reads and creates tasks, and nothing else. */
const agent: Actor = {
  _tag: "session",
  sessionId: SESSION_ID,
  profileId: "0199f0b7-0003-7000-8000-000000000000",
  grants: ["task.read", "task.create", "session.spawn"],
};

/** The grant a refusal names, or nothing where the check let the caller through. */
const readMissingGrant = (refused: ReturnType<typeof checkGrant>): string | undefined =>
  refused?.error.details.grant;

describe("buildActorStamp", () => {
  it("is the bare word for the user: which credential it presented is not its identity", () => {
    expect(buildActorStamp(user)).toBe("user");
  });

  it("is session:<id> for a session, which is what a reader follows back to it", () => {
    expect(buildActorStamp(agent)).toBe(`session:${SESSION_ID}`);
  });
});

describe("currentStamp", () => {
  it("stamps whoever the request resolved, so no service decides it", async () => {
    const stamps = await Effect.runPromise(
      Effect.all([
        Effect.provideService(currentStamp, CurrentActor, user),
        Effect.provideService(currentStamp, CurrentActor, agent),
      ]),
    );

    expect(stamps).toEqual(["user", `session:${SESSION_ID}`]);
  });

  it("dies on an actorless caller rather than attributing the write to the user", async () => {
    await expect(Effect.runPromise(currentStamp)).rejects.toThrow(
      "a write reached stamping with no authenticated actor behind it",
    );
  });
});

describe("checkGrant", () => {
  it("lets the user actor through every operation: parity is the ceiling", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(checkGrant(operation.id, user)).toBeUndefined();
    }
  });

  it("checks nothing when the operation asks only that a credential resolved", () => {
    expect(readRequirement("apiKey.query")).toBe("credential.read");
    expect(checkGrant("auth.wsTicket", nobody)).toBeUndefined();
  });

  it("names the grant an actor without parity is missing", () => {
    expect(readMissingGrant(checkGrant("secret.set", nobody))).toBe("secret.write");
  });

  it("lets a session through exactly the grants its profile holds", () => {
    expect(checkGrant("task.create", agent)).toBeUndefined();
    expect(readMissingGrant(checkGrant("task.delete", agent))).toBe("task.delete");
  });

  it("lets a session spawn, because whether a spawn is a Thread is in the payload", () => {
    // A spawn from an Agent is every actor's to make and a Thread is the
    // user's alone; this check runs before the payload that says which, so
    // placement is where the two are told apart.
    expect(checkGrant("session.spawn", agent)).toBeUndefined();
  });

  it("lets that same session continue one, on the same grant", () => {
    expect(readRequirement("session.continue")).toBe("session.spawn");
    expect(checkGrant("session.continue", agent)).toBeUndefined();
  });
});
