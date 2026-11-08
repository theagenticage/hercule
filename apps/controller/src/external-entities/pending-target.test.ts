/**
 * Tests that a pending target decodes to exactly what was encoded, and that
 * nothing else decodes. The table holds the awkward characters: the ones the
 * form uses as separators, percent signs, and non-ASCII text.
 */
import { describe, expect, it } from "vitest";
import {
  decodePendingTarget,
  encodePendingTarget,
  isPendingTarget,
  type PendingTarget,
} from "./pending-target";

const SCOPED_TARGETS: ReadonlyArray<readonly [string, PendingTarget, string]> = [
  [
    "an identifier with a kind and a scope",
    {
      form: "scoped",
      pluginId: "linear",
      kind: "linear/issue",
      scopeHint: "acme",
      identifier: "SHOP-123",
    },
    "unresolved:linear:linear%2Fissue:acme/SHOP-123",
  ],
  [
    "an identifier with no kind and no scope",
    { form: "scoped", pluginId: "github", identifier: "acme/api#87" },
    "unresolved:github::/acme%2Fapi%2387",
  ],
  [
    "separators inside every component",
    {
      form: "scoped",
      pluginId: "p",
      kind: "a:b/c",
      scopeHint: "x/y:z",
      identifier: "i/d:1",
    },
    "unresolved:p:a%3Ab%2Fc:x%2Fy%3Az/i%2Fd%3A1",
  ],
  [
    "a percent sign that is not an escape",
    { form: "scoped", pluginId: "p", scopeHint: "100%", identifier: "%2F" },
    "unresolved:p::100%25/%252F",
  ],
  [
    "non-ASCII text",
    { form: "scoped", pluginId: "p", kind: "k", scopeHint: "café", identifier: "名前-1" },
    "unresolved:p:k:caf%C3%A9/%E5%90%8D%E5%89%8D-1",
  ],
];

describe("encodePendingTarget and decodePendingTarget", () => {
  it.each(SCOPED_TARGETS)("round-trips %s", (_name, target, encoded) => {
    expect(encodePendingTarget(target)).toBe(encoded);
    expect(decodePendingTarget(encoded)).toEqual(target);
  });

  it("round-trips a web address as it is, including its own colons and slashes", () => {
    const target: PendingTarget = {
      form: "url",
      url: "https://example.test/a:b/c?d=e%20f#g",
    };
    expect(encodePendingTarget(target)).toBe("unresolved:url:https://example.test/a:b/c?d=e%20f#g");
    expect(decodePendingTarget("unresolved:url:https://example.test/a:b/c?d=e%20f#g")).toEqual(
      target,
    );
  });

  it("reads a plugin named url as a plugin, not as a web address", () => {
    const target: PendingTarget = {
      form: "scoped",
      pluginId: "url",
      kind: "https",
      identifier: "x",
    };
    const encoded = encodePendingTarget(target)!;
    expect(encoded).toBe("unresolved:url:https:/x");
    expect(decodePendingTarget(encoded)).toEqual(target);
  });

  it("does not encode what has no plugin or no identifier, or a lone surrogate", () => {
    expect(encodePendingTarget({ form: "scoped", pluginId: "", identifier: "x" })).toBeUndefined();
    expect(encodePendingTarget({ form: "scoped", pluginId: "p", identifier: "" })).toBeUndefined();
    expect(
      encodePendingTarget({ form: "scoped", pluginId: "p", identifier: "a\ud800" }),
    ).toBeUndefined();
  });

  it("treats an empty kind or scope as absent", () => {
    expect(
      encodePendingTarget({
        form: "scoped",
        pluginId: "p",
        kind: "",
        scopeHint: "",
        identifier: "x",
      }),
    ).toBe("unresolved:p::/x");
    expect(decodePendingTarget("unresolved:p::/x")).toEqual({
      form: "scoped",
      pluginId: "p",
      identifier: "x",
    });
  });

  it.each([
    ["an External Ref", "github:pull-request:acme/api#1"],
    ["the prefix alone", "unresolved:"],
    ["a missing identifier", "unresolved:p:k:s/"],
    ["a missing plugin", "unresolved::k:s/x"],
    ["an unescaped separator in an identifier", "unresolved:p:k:s/a/b"],
    ["a broken escape", "unresolved:p:k:s/%E0%A4%A"],
    ["a url form without a web address", "unresolved:url:ftp://x"],
  ])("decodes %s to nothing", (_name, value) => {
    expect(decodePendingTarget(value)).toBeUndefined();
  });

  it("tells a pending target from a ref by its prefix", () => {
    expect(isPendingTarget("unresolved:url:https://x.test")).toBe(true);
    expect(isPendingTarget("github:issue:acme/api#1")).toBe(false);
  });
});
