import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { ALL_OPERATIONS, requirementOf } from "@hydra/contract";
import { CurrentActor, currentStamp, grantCheck, stampOf, type Actor } from ".";

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
const missing = (refused: ReturnType<typeof grantCheck>): string | undefined =>
  refused?.error.details.grant;

describe("stampOf", () => {
  it("is the bare word for the user: which credential it presented is not its identity", () => {
    expect(stampOf(user)).toBe("user");
  });

  it("is session:<id> for a session, which is what a reader follows back to it", () => {
    expect(stampOf(agent)).toBe(`session:${SESSION_ID}`);
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

describe("grantCheck", () => {
  it("lets the user actor through every operation: parity is the ceiling", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(grantCheck(operation.id, user)).toBeUndefined();
    }
  });

  it("checks nothing when the operation asks only that a credential resolved", () => {
    expect(requirementOf("apiKey.query")).toBe("credential.read");
    expect(grantCheck("auth.wsTicket", nobody)).toBeUndefined();
  });

  it("names the grant an actor without parity is missing", () => {
    expect(missing(grantCheck("secret.set", nobody))).toBe("secret.write");
  });

  it("lets a session through exactly the grants its profile holds", () => {
    expect(grantCheck("task.create", agent)).toBeUndefined();
    expect(missing(grantCheck("task.delete", agent))).toBe("task.delete");
  });

  it("lets a session spawn, because whether a spawn is a Thread is in the payload", () => {
    // A spawn from an Agent is every actor's to make and a Thread is the
    // user's alone; this check runs before the payload that says which, so
    // placement is where the two are told apart.
    expect(grantCheck("session.spawn", agent)).toBeUndefined();
  });

  it("lets that same session continue one, on the same grant", () => {
    expect(requirementOf("session.continue")).toBe("session.spawn");
    expect(grantCheck("session.continue", agent)).toBeUndefined();
  });
});
