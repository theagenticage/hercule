/**
 * Tests which Skill names and which import inputs the contract accepts, and
 * the messages it refuses the others with.
 */
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { listDecodeIssues } from "../errors";
import { SkillImportInput, SkillName } from "./skill";

/** Decodes `input` and returns the message of every issue, or an empty list when it decodes. */
const listMessages = <T, E>(schema: Schema.Codec<T, E>, input: unknown) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.as([] as ReadonlyArray<string>),
      Effect.catch((error) =>
        Effect.succeed(listDecodeIssues(error).map((issue) => issue.message)),
      ),
    ),
  );

describe("SkillName", () => {
  it("accepts lowercase words joined by single hyphens, up to 64 characters", () => {
    for (const name of ["grilling", "write-docs", "a1-b2", "x".repeat(64)]) {
      expect(listMessages(SkillName, name), name).toEqual([]);
    }
  });

  it("refuses names the Agent Skills format does not allow", () => {
    for (const name of ["", "Grilling", "write_docs", "-docs", "write--docs", "x".repeat(65)]) {
      expect(listMessages(SkillName, name), name).not.toEqual([]);
    }
  });

  it("leaves the built-in skill's name to the content rules", () => {
    expect(listMessages(SkillName, "hercule")).toEqual([]);
  });
});

describe("SkillImportInput", () => {
  const github = { name: "grilling", sourceRepo: "acme/skills", sourcePath: "skills/grilling" };

  it("accepts an upload, and a GitHub source with or without a branch", () => {
    expect(listMessages(SkillImportInput, { name: "grilling" })).toEqual([]);
    expect(listMessages(SkillImportInput, github)).toEqual([]);
    expect(listMessages(SkillImportInput, { ...github, sourceBranch: "main" })).toEqual([]);
  });

  it("refuses a repository and a path given without each other", () => {
    for (const input of [
      { name: "grilling", sourceRepo: "acme/skills" },
      { name: "grilling", sourcePath: "skills/grilling" },
    ]) {
      expect(listMessages(SkillImportInput, input)).toEqual([
        "Give sourceRepo and sourcePath together for a GitHub source, or neither for an uploaded skill.",
      ]);
    }
  });

  it("refuses a branch without a repository and a path", () => {
    expect(listMessages(SkillImportInput, { name: "grilling", sourceBranch: "main" })).toEqual([
      "sourceBranch is the branch of a GitHub source, so it needs sourceRepo and sourcePath too.",
    ]);
  });

  it("refuses a repository that is not written owner/name", () => {
    for (const sourceRepo of [
      "acme",
      "acme/skills/extra",
      "acme/sk ills",
      "https://github.com/a/b",
    ]) {
      expect(listMessages(SkillImportInput, { ...github, sourceRepo }), sourceRepo).not.toEqual([]);
    }
  });

  it("refuses a path or a branch that would change which GitHub URL is read", () => {
    for (const text of [
      "../secrets",
      "skills?ref=x",
      "skills#top",
      "skills\nx",
      "skills\u0085x",
      "skills\u009bx",
    ]) {
      expect(listMessages(SkillImportInput, { ...github, sourcePath: text }), text).toEqual([
        "sourcePath may not hold `..`, `?`, `#` or a control character, because the update check puts it into a GitHub URL.",
      ]);
      expect(listMessages(SkillImportInput, { ...github, sourceBranch: text }), text).toEqual([
        "sourceBranch may not hold `..`, `?`, `#` or a control character, because the update check puts it into a GitHub URL.",
      ]);
    }
  });
});
