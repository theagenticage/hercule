/**
 * Tests which requests `sessionSkill.query` accepts, and the message it
 * refuses the others with.
 */
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { listDecodeIssues } from "../errors";
import { MAX_SPAWN_CHECKOUTS } from "./session";
import { SessionSkillFilter } from "./session-skill";

const SESSION = "0197a3c0-1111-7000-8000-000000000001";
const RUNNER = "0197a3c0-2222-7000-8000-000000000002";
const RESOURCE = "0197a3c0-3333-7000-8000-000000000003";

/** Decodes the request and returns the message of every issue, or an empty list when it decodes. */
const listMessages = (input: unknown) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(SessionSkillFilter)(input).pipe(
      Effect.as([] as ReadonlyArray<string>),
      Effect.catch((error) =>
        Effect.succeed(listDecodeIssues(error).map((issue) => issue.message)),
      ),
    ),
  );

describe("SessionSkillFilter", () => {
  it("accepts a session, or a runner with one or more resources", () => {
    expect(listMessages({ sessionId: SESSION })).toEqual([]);
    expect(listMessages({ runnerId: RUNNER, resourceId: [RESOURCE] })).toEqual([]);
    expect(listMessages({ runnerId: RUNNER, resourceId: [RESOURCE, SESSION] })).toEqual([]);
  });

  it("refuses a session together with a runner or a resource, naming the two forms", () => {
    for (const input of [
      { sessionId: SESSION, runnerId: RUNNER },
      { sessionId: SESSION, resourceId: [RESOURCE] },
      { sessionId: SESSION, runnerId: RUNNER, resourceId: [RESOURCE] },
    ]) {
      expect(listMessages(input)).toEqual([
        "Send sessionId alone, or runnerId with one or more resourceId, not both.",
      ]);
    }
  });

  it("refuses an empty request and a half-given draft, saying which fields to send", () => {
    const message =
      "Send sessionId for the skills of a session, or runnerId with one or more resourceId for the skills a new Thread would get.";
    for (const input of [
      {},
      { runnerId: RUNNER },
      { resourceId: [RESOURCE] },
      { runnerId: RUNNER, resourceId: [] },
    ]) {
      expect(listMessages(input)).toEqual([message]);
    }
  });

  it("refuses more resources than a thread's workspace may hold", () => {
    const resourceId = Array.from({ length: MAX_SPAWN_CHECKOUTS + 1 }, () => RESOURCE);
    expect(listMessages({ runnerId: RUNNER, resourceId })).not.toEqual([]);
  });
});
