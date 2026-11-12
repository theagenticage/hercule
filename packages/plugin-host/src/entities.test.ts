import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EntityObservation, MAX_ENTITY_FIELD_TEXT_LENGTH } from "./entities";

const isAccepted = (value: unknown): boolean =>
  Schema.decodeUnknownExit(EntityObservation)(value)._tag === "Success";

const FULL = {
  kind: "pull-request",
  ref: "acme:pr:acme/shop/12",
  title: "Round the totals",
  url: "https://example.test/acme/shop/pull/12",
  lifecycle: "open",
  fields: { number: 12, author: "pat", draft: null },
  concerns: ["review-requested"],
  sourceUpdatedAt: "2026-11-01T09:00:00Z",
};

const PARTIAL = { kind: "issue", ref: "acme:issue:acme/shop/3", title: "Parent", partial: true };

/** Returns the full observation without the named fields. */
const without = (...names: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(FULL).filter(([name]) => !names.includes(name)));

describe("EntityObservation", () => {
  it("accepts a full observation", () => {
    expect(isAccepted(FULL)).toBe(true);
  });

  it("accepts text, number, boolean and null field values, and refuses an object", () => {
    expect(isAccepted({ ...FULL, fields: { a: "x", b: 1, c: true, d: null } })).toBe(true);
    expect(isAccepted({ ...FULL, fields: { a: { nested: 1 } } })).toBe(false);
  });

  it("accepts a context observation that has no url, lifecycle or status", () => {
    expect(isAccepted({ ...without("url", "lifecycle"), concerns: [] })).toBe(true);
  });

  it("accepts a partial observation that carries only a kind, a ref and a title", () => {
    expect(
      isAccepted({ kind: "issue", ref: "acme:issue:acme/shop/3", title: "Parent", partial: true }),
    ).toBe(true);
  });

  it("refuses a full observation that leaves out what a full one needs", () => {
    expect(isAccepted(without("sourceUpdatedAt"))).toBe(false);
    expect(isAccepted(without("concerns"))).toBe(false);
    expect(isAccepted(without("fields"))).toBe(false);
  });

  it("refuses an oversized field and a ref that is not an External Ref", () => {
    const long = "x".repeat(MAX_ENTITY_FIELD_TEXT_LENGTH + 1);
    expect(isAccepted({ ...FULL, fields: { author: long } })).toBe(false);
    expect(isAccepted({ ...FULL, ref: "not a ref" })).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "//example.test/a",
    "not a link",
  ])("refuses the url %s, in a full and in a partial observation", (url) => {
    expect(isAccepted({ ...FULL, url })).toBe(false);
    expect(isAccepted({ ...PARTIAL, url })).toBe(false);
  });

  it("accepts an http and an https url", () => {
    expect(isAccepted({ ...FULL, url: "http://example.test/a" })).toBe(true);
    expect(isAccepted({ ...PARTIAL, url: "https://example.test/a" })).toBe(true);
  });
});
