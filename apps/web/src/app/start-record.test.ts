import { describe, expect, it } from "vitest";
import type { Project } from "@hercule/contract";
import { buildStartRecord, readListedProject } from "./start-record";

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

describe("readListedProject", () => {
  const project = { id: "p1", name: "webshop" } as Project;

  it("reads the project the page of projects holds", () => {
    expect(readListedProject({ data: { items: [project] }, error: null }, "p1")).toEqual({
      kind: "read",
      value: project,
    });
  });

  it("leaves a project the page does not hold to be read by its id", () => {
    expect(readListedProject({ data: { items: [project] }, error: null }, "p2")).toBeNull();
    expect(readListedProject({ data: undefined, error: null }, "p1")).toBeNull();
  });

  it("fails when the last read of the page failed, rather than offer the cached project", () => {
    expect(
      readListedProject({ data: { items: [project] }, error: new Error("It fell over.") }, "p1"),
    ).toEqual({ kind: "failed", message: "It fell over." });
  });
});
