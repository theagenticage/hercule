import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { ALL_GRANTS } from "../grants";
import { MAX_PROFILE_GRANTS, Profile } from "./profile";

const decodeOutcome = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input))._tag;

const buildProfile = (grants: ReadonlyArray<string>) => ({
  id: "01a06d02-beca-760b-a6b2-83af536c3c20",
  name: "operator",
  grants,
  shipped: false,
  createdAt: "2026-09-04T15:21:31.594Z",
  updatedAt: "2026-09-04T15:21:31.594Z",
});

describe("the bound on a profile's grant list", () => {
  it("is the grant vocabulary itself", () => {
    expect(MAX_PROFILE_GRANTS).toBe(ALL_GRANTS.length);
  });

  it("takes every grant once and refuses the one past it", () => {
    expect(decodeOutcome(Profile, buildProfile(ALL_GRANTS))).toBe("Success");
    expect(decodeOutcome(Profile, buildProfile([...ALL_GRANTS, "task.read"]))).toBe("Failure");
  });
});
