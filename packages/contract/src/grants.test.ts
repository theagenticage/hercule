import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ALL_GRANTS, GRANT_FAMILIES, GrantSchema } from "./grants";

describe("the grant vocabulary", () => {
  it("accepts a grant from the table and rejects anything else", () => {
    const decode = Schema.decodeUnknownEffect(GrantSchema);
    expect(Effect.runSync(decode("task.delete"))).toBe("task.delete");
    for (const bad of ["task.explode", "tasks.read", "task", "read.task", ""]) {
      expect(Effect.runSyncExit(decode(bad))._tag).toBe("Failure");
    }
  });

  it("carries event.audit, the verb the security entries of the log sit behind", () => {
    expect(GRANT_FAMILIES.event).toContain("audit");
    expect(ALL_GRANTS).toContain("event.audit");
    expect(Effect.runSync(Schema.decodeUnknownEffect(GrantSchema)("event.audit"))).toBe(
      "event.audit",
    );
  });

  it("has no duplicates and covers every family", () => {
    expect(new Set(ALL_GRANTS).size).toBe(ALL_GRANTS.length);
    expect(ALL_GRANTS).toContain("credential.write");
    expect(ALL_GRANTS).toContain("connection.use");
    for (const family of Object.keys(GRANT_FAMILIES)) {
      expect(ALL_GRANTS.some((grant) => grant.startsWith(`${family}.`))).toBe(true);
    }
  });
});
