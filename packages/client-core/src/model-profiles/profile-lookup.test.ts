/**
 * Tests the lookups of Model Profiles: the profile a project names, the
 * profile with an id, the profiles that hold an account and the projects a
 * profile serves.
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
  findModelProfileOrFirst,
  findProjectModelProfile,
  listAccountModelProfiles,
  listProjectsOfModelProfile,
} from "./profile-lookup";

const AT = "2026-09-05T09:00:00.000Z";

const MAIN = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])], {
  id: "profile-main",
  name: "Main",
});
const WORK = buildModelProfile(
  [
    buildProfileSection(OPENAI_IDENTITY, [buildProfileEntry(OPENAI_IDENTITY, "gpt-6")]),
    buildProfileSection(ANTHROPIC_IDENTITY, "pending"),
  ],
  { id: "profile-work", name: "Work" },
);

const buildProject = (id: string, fields: Partial<Project> = {}): Project => ({
  id,
  name: id,
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

describe("findProjectModelProfile", () => {
  const projects = [
    buildProject("p-work", { modelProfileId: WORK.id }),
    buildProject("p-plain"),
    buildProject("p-gone", { modelProfileId: "profile-deleted" }),
  ];

  it("returns the profile the project names", () => {
    expect(findProjectModelProfile(projects, [MAIN, WORK], "p-work")).toBe(WORK);
  });

  it.each([
    ["names no profile", "p-plain"],
    ["names a profile that was deleted", "p-gone"],
    ["does not exist", "p-unknown"],
    ["is null: the thread is outside any project", null],
  ])("returns nothing when the project %s", (_case, projectId) => {
    expect(findProjectModelProfile(projects, [MAIN, WORK], projectId)).toBeUndefined();
  });
});

describe("listAccountModelProfiles", () => {
  it("returns the profiles that hold the account, in the profiles' order, even with a pending section", () => {
    expect(listAccountModelProfiles([MAIN, WORK], ANTHROPIC_IDENTITY.id)).toEqual([MAIN, WORK]);
    expect(listAccountModelProfiles([WORK, MAIN], ANTHROPIC_IDENTITY.id)).toEqual([WORK, MAIN]);
  });

  it("leaves out a profile that holds other accounts only", () => {
    expect(listAccountModelProfiles([MAIN, WORK], OPENAI_IDENTITY.id)).toEqual([WORK]);
  });

  it("returns an empty list for an account no profile holds", () => {
    expect(listAccountModelProfiles([MAIN, WORK], "account-unknown")).toEqual([]);
  });
});

describe("findModelProfileOrFirst", () => {
  it("returns the profile with the id", () => {
    expect(findModelProfileOrFirst([MAIN, WORK], WORK.id)).toBe(WORK);
  });

  it.each([
    ["is undefined", undefined],
    ["names a profile that is gone", "profile-deleted"],
  ])("returns the first profile when the id %s", (_case, id) => {
    expect(findModelProfileOrFirst([MAIN, WORK], id)).toBe(MAIN);
  });

  it("returns nothing when there is no profile", () => {
    expect(findModelProfileOrFirst([], "profile-main")).toBeUndefined();
  });
});

describe("listProjectsOfModelProfile", () => {
  it("returns the projects that name the profile, in order", () => {
    const projects = [
      buildProject("api", { modelProfileId: WORK.id }),
      buildProject("site", { modelProfileId: MAIN.id }),
      buildProject("docs"),
      buildProject("app", { modelProfileId: WORK.id }),
    ];

    expect(listProjectsOfModelProfile(projects, WORK.id).map(({ id }) => id)).toEqual([
      "api",
      "app",
    ]);
  });
});
