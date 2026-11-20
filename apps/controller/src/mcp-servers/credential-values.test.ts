import { describe, expect, it } from "vitest";
import { McpSchema } from "effect/ai";
import { removeCredentialValues } from "./credential-values";

describe("removeCredentialValues", () => {
  it("replaces a value in every string of a result, nested or not, and keeps the class of the result", () => {
    const result = new McpSchema.CallToolResult({
      content: [
        { type: "text", text: "sent Bearer abc123xyz9 and abc123xyz9" },
        { type: "text", text: "nothing here" },
      ],
      structuredContent: { echoed: { header: ["abc123xyz9"] }, count: 2 },
    });

    const cleaned = removeCredentialValues(result, new Set(["abc123xyz9"]));

    expect(cleaned).toBeInstanceOf(McpSchema.CallToolResult);
    expect(cleaned.content[0]).toMatchObject({ text: "sent Bearer [removed] and [removed]" });
    expect(cleaned.structuredContent).toEqual({ echoed: { header: ["[removed]"] }, count: 2 });
    // What held no value is not copied.
    expect(cleaned.content[1]).toBe(result.content[1]);
  });

  it("removes a longer value whole before a shorter one inside it, and returns the same value when nothing matches", () => {
    const secrets = new Set(["abc123xyz9", "Bearer abc123xyz9"]);

    expect(removeCredentialValues("Authorization: Bearer abc123xyz9", secrets)).toBe(
      "Authorization: [removed]",
    );
    const untouched = { text: "nothing" };
    expect(removeCredentialValues(untouched, secrets)).toBe(untouched);
  });

  it("removes a value from object keys too, and keeps every entry when keys end up with one name", () => {
    const secrets = new Set(["abc123xyz9", "def456uvw8"]);
    const result = {
      abc123xyz9: "first",
      "[removed]": "an honest key",
      "a-abc123xyz9": { "b-def456uvw8": 1 },
      "a-def456uvw8": 2,
    };

    const cleaned = removeCredentialValues(result, secrets);

    expect(cleaned).toEqual({
      "[removed]-2": "first",
      "[removed]": "an honest key",
      "a-[removed]": { "b-[removed]": 1 },
      "a-[removed]-2": 2,
    });
  });

  it("keeps the prototype of an object that has a key named `__proto__`, when it copies it", () => {
    const parsed = JSON.parse('{"__proto__": {"echo": "abc123xyz9"}}') as object;

    const cleaned = removeCredentialValues(parsed, new Set(["abc123xyz9"]));

    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(Object.keys(cleaned)).toEqual(["__proto__"]);
  });
});
