import { describe, expect, it } from "vitest";
import { readRequirement } from "@hercule/contract";
import { buildOperationId } from "./middleware";

describe("buildOperationId", () => {
  it("is the group and endpoint identifiers joined, which is the operation id", () => {
    const id = buildOperationId({
      group: { identifier: "profile" } as never,
      endpoint: { identifier: "update" } as never,
    });
    expect(id).toBe("profile.update");
    expect(readRequirement("profile.update")).toBe("permission.write");
  });
});
