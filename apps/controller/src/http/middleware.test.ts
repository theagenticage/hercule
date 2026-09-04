import { describe, expect, it } from "vitest";
import { ALL_OPERATIONS, requirementOf } from "@hydra/contract";
import type { Actor } from "../actor";
import { grantCheck, operationIdOf } from "./middleware";

const user: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "abc" },
};

const nobody: Actor = { _tag: "none" };

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
      expect(grantCheck(operation.requires, user)).toBeUndefined();
    }
  });

  it("checks nothing when the operation asks only that a credential resolved", () => {
    expect(grantCheck("authenticated", nobody)).toBeUndefined();
  });

  it("names the grant an actor without parity is missing", () => {
    expect(grantCheck("secret.write", nobody)).toBe("secret.write");
  });
});
