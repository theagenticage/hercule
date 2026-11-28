import { describe, expect, it } from "vitest";
import { MAX_FACT_LENGTH } from "@hercule/protocol";
import { buildEditedPathFields } from "./edited-paths";

describe("buildEditedPathFields", () => {
  it("writes `path` for one file and `paths` for several", () => {
    expect(buildEditedPathFields(["/a.ts"])).toEqual({ path: "/a.ts" });
    expect(buildEditedPathFields(["/a.ts", "b.ts"])).toEqual({ paths: ["/a.ts", "b.ts"] });
  });

  it("keeps a long path whole up to the fact limit", () => {
    const path = `/${"a".repeat(MAX_FACT_LENGTH - 1)}`;
    expect(buildEditedPathFields([path])).toEqual({ path });
  });

  it("leaves out an empty path and a path over the fact limit", () => {
    const tooLong = `/${"a".repeat(MAX_FACT_LENGTH)}`;
    expect(buildEditedPathFields(["", tooLong])).toBeUndefined();
    expect(buildEditedPathFields([tooLong, "/a.ts"])).toEqual({ path: "/a.ts" });
  });

  it("lists a repeated path once", () => {
    expect(buildEditedPathFields(["/a.ts", "/a.ts"])).toEqual({ path: "/a.ts" });
  });
});
