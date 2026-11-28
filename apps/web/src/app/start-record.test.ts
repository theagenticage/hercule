import { describe, expect, it } from "vitest";
import type { Project } from "@hercule/contract";
import { readListedProject } from "./start-record";

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
