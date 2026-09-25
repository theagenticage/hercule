import { describe, expect, it } from "vitest";
import { buildIdOptions } from "./id-options";

const PERSONAL = { id: "01a06d02-1000-7000-8000-000000000001", label: "Claude Code" };
const WORK = { id: "01a06d02-1000-7000-8000-000000000002", label: "Claude Code (work)" };

describe("buildIdOptions", () => {
  it("returns the choices as they are when the stored id is one of them", () => {
    expect(buildIdOptions([PERSONAL, WORK], WORK.id)).toEqual([PERSONAL, WORK]);
  });

  it("returns the choices as they are when nothing is stored", () => {
    expect(buildIdOptions([PERSONAL, WORK], null)).toEqual([PERSONAL, WORK]);
  });

  it("adds the stored id at the end, marked not found, when no choice has it", () => {
    expect(buildIdOptions([PERSONAL], "01a06d02-1000-7000-8000-0000000000ff")).toEqual([
      PERSONAL,
      { id: "01a06d02-1000-7000-8000-0000000000ff", label: "000000ff (not found)" },
    ]);
  });

  it("adds the stored id when there are no choices at all", () => {
    expect(buildIdOptions([], "01a06d02-1000-7000-8000-0000000000ff")).toEqual([
      { id: "01a06d02-1000-7000-8000-0000000000ff", label: "000000ff (not found)" },
    ]);
  });

  it("marks the stored id as list not loaded, not as not found, when the list is not loaded", () => {
    expect(buildIdOptions(null, "01a06d02-1000-7000-8000-0000000000ff")).toEqual([
      { id: "01a06d02-1000-7000-8000-0000000000ff", label: "000000ff (list not loaded)" },
    ]);
  });

  it("returns no options when the list is not loaded and nothing is stored", () => {
    expect(buildIdOptions(null, null)).toEqual([]);
  });
});
