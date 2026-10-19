/**
 * Tests what `session.previewSkills` accepts and how a repository skill is
 * named.
 */
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { listDecodeIssues } from "../errors";
import { MAX_SPAWN_CHECKOUTS, SkillsPreviewFilter } from "./session";
import { RepositorySkillName } from "./session-skill";

const RUNNER = "0197a3c0-2222-7000-8000-000000000002";
const RESOURCE = "0197a3c0-3333-7000-8000-000000000003";

/** Decodes the request and returns the message of every issue, or an empty list when it decodes. */
const listMessages = (input: unknown) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(SkillsPreviewFilter)(input).pipe(
      Effect.as([] as ReadonlyArray<string>),
      Effect.catch((error) =>
        Effect.succeed(listDecodeIssues(error).map((issue) => issue.message)),
      ),
    ),
  );

describe("SkillsPreviewFilter", () => {
  it("accepts a runner with one to the most resources a workspace may hold", () => {
    expect(listMessages({ runnerId: RUNNER, resourceId: [RESOURCE] })).toEqual([]);
    const most = Array.from({ length: MAX_SPAWN_CHECKOUTS }, () => RESOURCE);
    expect(listMessages({ runnerId: RUNNER, resourceId: most })).toEqual([]);
  });

  it("accepts a request with neither a runner nor resources, which asks for the library alone", () => {
    expect(listMessages({})).toEqual([]);
  });

  it("leaves refusing a runner without resources, or resources without a runner, to the controller", () => {
    expect(listMessages({ runnerId: RUNNER })).toEqual([]);
    expect(listMessages({ resourceId: [RESOURCE] })).toEqual([]);
  });

  it("refuses an empty resource list and one with too many resources", () => {
    const tooMany = Array.from({ length: MAX_SPAWN_CHECKOUTS + 1 }, () => RESOURCE);
    for (const input of [
      { runnerId: RUNNER, resourceId: [] },
      { runnerId: RUNNER, resourceId: tooMany },
    ]) {
      expect(listMessages(input), JSON.stringify(input)).not.toEqual([]);
    }
  });
});

describe("RepositorySkillName", () => {
  const accepts = Schema.is(RepositorySkillName);

  it("accepts <checkout>:<skill> with both parts following the Agent Skills name rule", () => {
    expect(accepts("hercule:release")).toBe(true);
    expect(accepts("foo-js:release-2")).toBe(true);
  });

  it("refuses a name without a prefix, with a third part, or with a part that breaks the rule", () => {
    for (const name of ["release", "a:b:c", "Hercule:release", "foo.js:release", "a-:b", ":b"]) {
      expect(accepts(name), name).toBe(false);
    }
    expect(accepts(`${"a".repeat(65)}:b`)).toBe(false);
    expect(accepts(`a:${"b".repeat(65)}`)).toBe(false);
  });
});
