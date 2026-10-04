import { describe, expect, it } from "vitest";
import { OwnerKind } from "@hercule/contract";
import { describeReadOnlySecret, WRITABLE_OWNER_KINDS } from "./secret-owners";

describe("describeReadOnlySecret", () => {
  it("names what a secret is when the API refuses to write it", () => {
    expect(describeReadOnlySecret("core")).toBe("controller key");
    expect(describeReadOnlySecret("connection")).toBe("connection credential");
  });

  it("has a note for exactly the owner kinds the user may not write", () => {
    const writable: ReadonlyArray<OwnerKind> = WRITABLE_OWNER_KINDS;
    for (const kind of OwnerKind.literals) {
      expect(describeReadOnlySecret(kind) === undefined, kind).toBe(writable.includes(kind));
    }
  });
});
