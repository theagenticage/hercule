/**
 * Tests the count of a Model Profile's entries.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
} from "../providers.testing";
import { countProfileEntries } from "./profile-entries";

describe("countProfileEntries", () => {
  it("adds up the entries of every account, and counts a pending account as none", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [
        buildProfileEntry(ANTHROPIC_IDENTITY, "opus"),
        buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet"),
      ]),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);

    expect(countProfileEntries(profile)).toBe(2);
    expect(countProfileEntries(buildModelProfile([]))).toBe(0);
  });
});
