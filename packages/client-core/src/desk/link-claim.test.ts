/** Tests the words for a link's claim and for a hint. */
import type { EntityLink } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { describeClaim, describeHint } from "./link-claim";

const PLUGINS = [{ id: "linear", displayName: "Linear" }];

describe("describeClaim", () => {
  const cases: ReadonlyArray<readonly [string, EntityLink["claim"], string]> = [
    [
      "a source claim names the plugin",
      { type: "source", plugin: "linear" },
      "Linear reports this",
    ],
    [
      "a plugin that is not listed keeps its id",
      { type: "source", plugin: "sentry" },
      "sentry reports this",
    ],
    ["a source claim with no plugin", { type: "source" }, "The source reports this"],
    ["a person claim is the user's", { type: "person", actor: "user" }, "You linked this"],
  ];
  it.each(cases)("%s", (_name, claim, expected) => {
    expect(describeClaim(claim, PLUGINS)).toBe(expected);
  });
});

describe("describeHint", () => {
  it.each([
    [
      "names where it was found",
      { evidenceKey: "description" },
      undefined,
      "Found in the description",
    ],
    [
      "names whose text it is",
      { evidenceKey: "description" },
      "#6263",
      "Found in the description of #6263",
    ],
    ["with no evidence key", {}, undefined, "Found in the text"],
  ])("%s", (_name, hint, mentioner, expected) => {
    expect(describeHint(hint, mentioner)).toBe(expected);
  });
});
