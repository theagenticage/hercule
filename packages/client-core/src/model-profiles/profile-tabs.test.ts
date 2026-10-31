/**
 * Tests what the profile tabs need: which profile is open, how many models a
 * tab counts, the name a copy starts with, and which projects use a profile.
 */
import { describe, expect, it } from "vitest";
import type { Project } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
} from "../providers.testing";
import {
  buildModelProfileCopyName,
  countModelProfileEntries,
  findOpenModelProfile,
  listProjectsOfModelProfile,
} from "./profile-tabs";

const buildNamed = (id: string, name: string) => buildModelProfile([], { id, name });
const MAIN = buildNamed("profile-main", "Main");
const WORK = buildNamed("profile-work", "Work");

describe("findOpenModelProfile", () => {
  it("returns the profile with the id", () => {
    expect(findOpenModelProfile([MAIN, WORK], WORK.id)).toBe(WORK);
  });

  it.each([
    ["is undefined", undefined],
    ["names a profile that is gone", "profile-deleted"],
  ])("returns the first profile when the id %s", (_case, id) => {
    expect(findOpenModelProfile([MAIN, WORK], id)).toBe(MAIN);
  });

  it("returns nothing when there is no profile", () => {
    expect(findOpenModelProfile([], "profile-main")).toBeUndefined();
  });
});

describe("countModelProfileEntries", () => {
  it("adds up the entries of every account, and counts a pending account as none", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "opus"),
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet"),
      ]),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);

    expect(countModelProfileEntries(profile)).toBe(2);
    expect(countModelProfileEntries(MAIN)).toBe(0);
  });
});

describe("buildModelProfileCopyName", () => {
  it("adds ' copy' to the name", () => {
    expect(buildModelProfileCopyName([MAIN, WORK], "Work")).toBe("Work copy");
  });

  it("takes the next free number when the earlier copies exist", () => {
    const profiles = [MAIN, buildNamed("a", "Main copy"), buildNamed("b", "Main copy 2")];

    expect(buildModelProfileCopyName(profiles, "Main")).toBe("Main copy 3");
  });
});

describe("listProjectsOfModelProfile", () => {
  const buildProject = (id: string, modelProfileId?: string): Project => ({
    id,
    name: id,
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
    createdAt: "2026-09-05T09:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
  });

  it("returns the projects that name the profile, in order", () => {
    const projects = [
      buildProject("api", WORK.id),
      buildProject("site", MAIN.id),
      buildProject("docs"),
      buildProject("app", WORK.id),
    ];

    expect(listProjectsOfModelProfile(projects, WORK.id).map(({ id }) => id)).toEqual([
      "api",
      "app",
    ]);
  });
});
