/**
 * Tests the label a new connection gets when the user gives none: the account
 * name, cut to the longest label allowed, or the type's name when the account
 * has none.
 */
import { describe, expect, it } from "vitest";
import { MAX_CONNECTION_LABEL_LENGTH } from "@hercule/contract";
import { buildDefaultLabel } from "./default-label";

/** An emoji outside the Basic Multilingual Plane: two UTF-16 code units. */
const EMOJI = "\u{1F600}";

describe("buildDefaultLabel", () => {
  it("returns the account name as it is", () => {
    expect(buildDefaultLabel("rogierpennink", "GitHub")).toBe("rogierpennink");
    expect(buildDefaultLabel(" padded ", "GitHub")).toBe(" padded ");
  });

  it("keeps an account name of exactly the longest label length", () => {
    const name = "a".repeat(MAX_CONNECTION_LABEL_LENGTH);

    expect(buildDefaultLabel(name, "GitHub")).toBe(name);
  });

  it("cuts a longer account name to the longest label length", () => {
    const name = "a".repeat(MAX_CONNECTION_LABEL_LENGTH + 72);

    expect(buildDefaultLabel(name, "GitHub")).toBe("a".repeat(MAX_CONNECTION_LABEL_LENGTH));
  });

  it("drops a surrogate pair the cut would split, rather than keep half of it", () => {
    // The emoji's first code unit is the last one that fits.
    const name = `${"a".repeat(MAX_CONNECTION_LABEL_LENGTH - 1)}${EMOJI}tail`;

    const label = buildDefaultLabel(name, "GitHub");

    expect(label).toBe("a".repeat(MAX_CONNECTION_LABEL_LENGTH - 1));
  });

  it("keeps a surrogate pair that ends exactly at the cut", () => {
    const name = `${"a".repeat(MAX_CONNECTION_LABEL_LENGTH - 2)}${EMOJI}tail`;

    expect(buildDefaultLabel(name, "GitHub")).toBe(
      `${"a".repeat(MAX_CONNECTION_LABEL_LENGTH - 2)}${EMOJI}`,
    );
  });

  it("falls back to the type's name when the account name is empty or only whitespace", () => {
    expect(buildDefaultLabel("", "GitHub")).toBe("GitHub");
    expect(buildDefaultLabel(" \t\n", "GitHub")).toBe("GitHub");
  });

  it("cuts a fallback type name that is longer than a label may be", () => {
    // A type's display name has no maximum length of its own.
    const typeName = "T".repeat(MAX_CONNECTION_LABEL_LENGTH + 1);

    expect(buildDefaultLabel("", typeName)).toBe("T".repeat(MAX_CONNECTION_LABEL_LENGTH));
  });
});
