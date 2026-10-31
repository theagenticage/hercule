import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { HarnessHome } from "@hercule/protocol";
import { resolveHarnessHome } from "./harness-home";

const ID = "0199e0e7-0000-7000-8000-000000000001";

const FRESH = { id: ID, legacyHomeFolder: null, legacyHomeHarnessId: null };

const MIGRATED = {
  id: ID,
  legacyHomeFolder: "0199e0e7-aaaa-7000-8000-000000000002",
  legacyHomeHarnessId: "codex/codex",
};

const isValidHome = Schema.is(HarnessHome);

describe("resolveHarnessHome", () => {
  it("derives the home of an account with no legacy folder, one folder level per part of the harness id", () => {
    expect(resolveHarnessHome(FRESH, "claude-code/claude-code")).toBe(
      `providers/homes/${ID}/claude-code/claude-code`,
    );
  });

  it("keeps the legacy folder for the harness the instance ran", () => {
    expect(resolveHarnessHome(MIGRATED, "codex/codex")).toBe(
      "providers/0199e0e7-aaaa-7000-8000-000000000002",
    );
  });

  it("gives another harness of a migrated account a derived home, never inside the legacy one", () => {
    expect(resolveHarnessHome(MIGRATED, "pi/pi")).toBe(`providers/homes/${ID}/pi/pi`);
  });

  it("returns a path the protocol accepts for both shapes", () => {
    expect(isValidHome(resolveHarnessHome(FRESH, "pi/pi"))).toBe(true);
    expect(isValidHome(resolveHarnessHome(MIGRATED, "codex/codex"))).toBe(true);
    expect(isValidHome(resolveHarnessHome(MIGRATED, "pi/pi"))).toBe(true);
  });
});
