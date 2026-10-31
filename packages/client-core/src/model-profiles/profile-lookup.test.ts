/**
 * Tests the two lookups of Model Profiles: the profile a project names
 * (`findProjectModelProfile`) and the profiles that hold an account
 * (`listAccountModelProfiles`).
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
import { findProjectModelProfile, listAccountModelProfiles } from "./profile-lookup";

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
