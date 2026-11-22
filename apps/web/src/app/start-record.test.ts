import { describe, expect, it } from "vitest";
import { buildStartRecord } from "./start-record";

const pickLength = (data: string): number => data.length;

describe("buildStartRecord", () => {
  it("is pending for a query that has read nothing", () => {
    expect(buildStartRecord({ data: undefined, error: null }, pickLength)).toEqual({
      kind: "pending",
    });
  });

  it("holds the value made of the data of a query that read", () => {
    expect(buildStartRecord({ data: "abc", error: null }, pickLength)).toEqual({
      kind: "read",
      value: 3,
    });
  });

  it("fails with the reason when the last read failed, with no data", () => {
    expect(
      buildStartRecord({ data: undefined, error: new Error("It fell over.") }, pickLength),
    ).toEqual({ kind: "failed", message: "It fell over." });
  });

  it("fails when the last read failed after an earlier read, rather than offer the obsolete data", () => {
    expect(
      buildStartRecord({ data: "abc", error: new Error("It fell over.") }, pickLength),
    ).toEqual({ kind: "failed", message: "It fell over." });
  });
});
