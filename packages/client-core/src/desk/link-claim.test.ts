/** Tests the words for a link's claim. */
import type { EntityLink } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { describeClaim } from "./link-claim";

const PLUGINS = [{ id: "linear", displayName: "Linear" }];

describe("describeClaim", () => {
  const cases: ReadonlyArray<readonly [string, EntityLink["claim"], string | undefined, string]> = [
    [
      "a source claim names the plugin",
      { type: "source", plugin: "linear" },
      undefined,
      "Linear reports this",
    ],
    [
      "a plugin that is not listed keeps its id",
      { type: "source", plugin: "sentry" },
      undefined,
      "sentry reports this",
    ],
    ["a source claim with no plugin", { type: "source" }, undefined, "The source reports this"],
    [
      "a person claim is the user's",
      { type: "person", actor: "user" },
      undefined,
      "You linked this",
    ],
    [
      "a text claim names where it was found",
      { type: "text", evidenceKey: "description" },
      undefined,
      "Found in the description",
    ],
    [
      "a text claim names whose text it is",
      { type: "text", evidenceKey: "description" },
      "#6263",
      "Found in the description of #6263",
    ],
    ["a text claim with no evidence key", { type: "text" }, undefined, "Found in the text"],
  ];
  it.each(cases)("%s", (_name, claim, mentioner, expected) => {
    expect(describeClaim(claim, PLUGINS, mentioner)).toBe(expected);
  });
});
