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

  it("defaults to the user, which no write ever reaches: a grant refuses nobody first", async () => {
    expect(await Effect.runPromise(currentStamp)).toBe("user");
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

  it("refuses a session the spawn its profile does grant, saying whose a Thread is", () => {
    const refused = grantCheck("session.spawn", agent);

    expect(missing(refused)).toBe("session.spawn");
    expect(refused?.error.message.toLowerCase()).toContain("thread");
  });

  it("lets that same session continue one, because a fork is not a Thread", () => {
    // Both operations require `session.spawn`; only the spawn is refused.
    expect(requirementOf("session.continue")).toBe("session.spawn");
    expect(grantCheck("session.continue", agent)).toBeUndefined();
  });
});
