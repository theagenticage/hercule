/**
 * Tests the name a copy of a Model Profile starts with.
 */
import { describe, expect, it } from "vitest";
import { MAX_MODEL_PROFILE_NAME_LENGTH } from "@hercule/contract";
import { buildModelProfile } from "../providers.testing";
import { buildModelProfileCopyName } from "./profile-tabs";

const buildNamed = (id: string, name: string) => buildModelProfile([], { id, name });
const MAIN = buildNamed("profile-main", "Main");
const WORK = buildNamed("profile-work", "Work");

describe("buildModelProfileCopyName", () => {
  it("adds ' copy' to the name", () => {
    expect(buildModelProfileCopyName([MAIN, WORK], "Work")).toBe("Work copy");
  });

  it("takes the next free number when the earlier copies exist", () => {
    const profiles = [MAIN, buildNamed("a", "Main copy"), buildNamed("b", "Main copy 2")];

    expect(buildModelProfileCopyName(profiles, "Main")).toBe("Main copy 3");
  });

  it("cuts a long name short so the copy's name still fits a profile name", () => {
    const long = buildNamed("long", "x".repeat(MAX_MODEL_PROFILE_NAME_LENGTH));
    const copy = buildModelProfileCopyName([long], long.name);

    expect(copy).toBe(`${"x".repeat(MAX_MODEL_PROFILE_NAME_LENGTH - 5)} copy`);
    expect(copy).toHaveLength(MAX_MODEL_PROFILE_NAME_LENGTH);
  });

  it("keeps the numbered copies of a long name within the limit and apart from each other", () => {
    const long = buildNamed("long", "x".repeat(MAX_MODEL_PROFILE_NAME_LENGTH));
    const first = buildModelProfileCopyName([long], long.name);
    const second = buildModelProfileCopyName([long, buildNamed("c1", first)], long.name);

    expect(second).not.toBe(first);
    expect(second).toHaveLength(MAX_MODEL_PROFILE_NAME_LENGTH);
    expect(second.endsWith(" copy 2")).toBe(true);
  });
});
