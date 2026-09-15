import { describe, expect, it } from "vitest";
import { ALL_OPERATIONS, requirementOf } from "@hydra/contract";
import { grantCheck, type Actor } from "../actor";
import { operationIdOf } from "./middleware";

const user: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "abc" },
};

const nobody: Actor = { _tag: "none" };

/** A session on a profile that reads and creates tasks, and nothing else. */
const agent: Actor = {
  _tag: "session",
  sessionId: "0199f0b7-0002-7000-8000-000000000000",
  profileId: "0199f0b7-0003-7000-8000-000000000000",
  grants: ["task.read", "task.create", "session.spawn"],
};

/** The grant a refusal names, or nothing where the check let the caller through. */
const missing = (refused: ReturnType<typeof grantCheck>): string | undefined =>
  refused?.error.details.grant;

describe("operationIdOf", () => {
  it("is the group and endpoint identifiers joined, which is the operation id", () => {
    const id = operationIdOf({
      group: { identifier: "profile" } as never,
      endpoint: { identifier: "update" } as never,
    });
    expect(id).toBe("profile.update");
    expect(requirementOf("profile.update")).toBe("permission.write");
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
