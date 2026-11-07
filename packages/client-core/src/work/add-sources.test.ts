/**
 * Tests which plugins are sources of the Add sheet, which places narrow a
 * search, and what counts as a pasted link.
 */
import { describe, expect, it } from "vitest";
import type { EntityPlace } from "@hercule/contract";
import { buildPlace } from "./cards.testing";
import { isPastedLink, listAddSources, listScopeOptions, type SourcePlugin } from "./add-sources";

const KIND = {
  word: "relay/issue",
  noun: "Issue",
  card: "compact",
  pace: "fast",
  patience: 24,
} as unknown as SourcePlugin["entityKinds"][number];

const buildPlugin = (id: string, overrides: Partial<SourcePlugin> = {}): SourcePlugin => ({
  id,
  displayName: id,
  enabled: true,
  status: { _tag: "active" },
  entityKinds: [KIND],
  ...overrides,
});

describe("listAddSources", () => {
  it("lists the running plugins that declare entity kinds, ordered by name", () => {
    const sources = listAddSources([
      buildPlugin("relay", { displayName: "Relay" }),
      buildPlugin("acme", { displayName: "Acme" }),
    ]);

    expect(sources).toEqual([
      { id: "acme", name: "Acme" },
      { id: "relay", name: "Relay" },
    ]);
  });

  it.each([
    ["a plugin with no entity kinds", { entityKinds: [] }],
    ["a disabled plugin", { enabled: false }],
    ["a plugin that is not running", { status: { _tag: "inactive" } }],
  ] as const)("leaves out %s", (_name, overrides) => {
    expect(listAddSources([buildPlugin("relay", overrides)])).toEqual([]);
  });
});

describe("listScopeOptions", () => {
  // A kind that cannot group things has no caption.
  const issue: EntityPlace = {
    ref: "relay:issue:1",
    kind: "relay/issue",
    noun: "Issue",
    title: "An issue",
    restricted: false,
  };
  const PLACES = [
    buildPlace("relay:team:web", "Web", { kind: "relay/team", noun: "Team" }),
    buildPlace("relay:project:basket", "Basket rebuild", {
      kind: "relay/project",
      noun: "Project",
    }),
    buildPlace("acme:project:returns", "Returns"),
    issue,
  ];

  it("offers the groupable places of the source, by title, labelled with their kind", () => {
    const options = listScopeOptions(PLACES, "relay");

    expect(options.map((option) => option.label)).toEqual([
      "Basket rebuild (project)",
      "Web (team)",
    ]);
  });

  it("leaves out a place the user cannot read", () => {
    const options = listScopeOptions(
      [buildPlace("relay:team:secret", "Secret", { kind: "relay/team", restricted: true })],
      "relay",
    );

    expect(options).toEqual([]);
  });
});

describe("isPastedLink", () => {
  it.each([
    ["https://github.example/acme/storefront-web/issues/7", true],
    ["  http://linear.example/issue/WEB-301  ", true],
    ["WEB-301", false],
    ["https://github.example/a b", false],
    ["see https://github.example/a", false],
    ["", false],
  ])("answers %j with %s", (text, expected) => {
    expect(isPastedLink(text)).toBe(expected);
  });
});
