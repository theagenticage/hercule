import { describe, expect, it } from "vitest";
import { requirementOf } from "@hercule/contract";
import { operationIdOf } from "./middleware";

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
