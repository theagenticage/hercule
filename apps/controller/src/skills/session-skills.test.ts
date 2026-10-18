import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { skillRepository } from "./repository";
import { decideSessionSkills } from "./session-skills";

const CHANGE = { at: "2026-10-18T00:00:00.000Z", actor: "user" } as const;

/**
 * Inserts a Skill with one revision whose hash is `hash`. The revision is made
 * current when `apply` is true; otherwise it stays proposed by a session.
 */
const insertSkill = (name: string, hash: string, apply: boolean) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const skills = yield* skillRepository;
        const id = yield* skills.insert(name, { kind: "upload" }, CHANGE);
        yield* skills.insertRevision(id, {
          hash,
          origin: apply ? "import" : "session",
          fileCount: 1,
          sizeBytes: 10,
          description: "Teaches.",
          approvalEffects: { allowedTools: null, hooks: null },
          ...CHANGE,
        });
        if (apply) yield* skills.applyRevision(id, hash, CHANGE);
      }),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe("decideSessionSkills", () => {
  it("gives a Thread the current revision of every Skill, sorted by name, and skips a proposed-only Skill", async () => {
    const decided = await run(
      Effect.gen(function* () {
        yield* insertSkill("teach", "b".repeat(64), true);
        yield* insertSkill("implement", "a".repeat(64), true);
        yield* insertSkill("draft", "c".repeat(64), false);
        return yield* decideSessionSkills({ agentId: null });
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(decided).toEqual([
      { name: "implement", revisionHash: "a".repeat(64), description: "Teaches." },
      { name: "teach", revisionHash: "b".repeat(64), description: "Teaches." },
    ]);
  });

  it("gives a session spawned from an Agent, as every assistant and agent step session is, no skills", async () => {
    const decided = await run(
      Effect.gen(function* () {
        yield* insertSkill("teach", "b".repeat(64), true);
        return yield* decideSessionSkills({ agentId: "0199f0b7-0000-7000-8000-000000000000" });
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(decided).toEqual([]);
  });
});
