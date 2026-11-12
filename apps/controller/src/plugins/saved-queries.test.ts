/**
 * Tests the load-time check of an event source's saved queries: a valid one
 * is qualified with the plugin's id, and each mistake refuses the source with
 * a message that names the query and says what to do.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  InboxClause,
  PluginManifest,
  QualifiedEntityKindDeclaration,
  SavedQuery,
} from "@hercule/plugin-host";
import { decodeSavedQueries, type SavedQueryContext } from "./saved-queries";

const MANIFEST: PluginManifest = {
  id: "acme",
  displayName: "Acme",
  hostApi: 8,
  capabilities: ["event-sources", "events", "entities"],
  configSchema: Schema.Struct({}),
};

/** Builds the part of a qualified kind that a saved query reads: its word and fields. */
const buildKind = (
  word: string,
  fields: ReadonlyArray<Record<string, unknown>> = [],
): QualifiedEntityKindDeclaration =>
  ({ word, fields }) as unknown as QualifiedEntityKindDeclaration;

const CONTEXT: SavedQueryContext = {
  signalKinds: new Set(["acme/asked"]),
  entityKinds: [
    buildKind("acme/ticket", [
      { key: "team", label: "Team", type: "text" },
      { key: "size", label: "Size", type: "number" },
      { key: "opened", label: "Opened", type: "age" },
      { key: "flag", label: "Flag", type: "bool" },
    ]),
  ],
  takenIds: new Set(),
};

const buildQuery = (
  clauses: ReadonlyArray<InboxClause>,
  overrides: Partial<SavedQuery> = {},
): SavedQuery => ({ word: "mine", name: "Mine", order: "waiting", clauses, ...overrides });

/** Decodes the queries, and returns the registered ones or the refusal's message. */
const decode = (declarations: ReadonlyArray<SavedQuery>, context: SavedQueryContext = CONTEXT) =>
  Effect.runPromise(
    Effect.match(decodeSavedQueries(MANIFEST, "tracker", declarations, context), {
      onFailure: (error) => error.message,
      onSuccess: (queries) => queries,
    }),
  );

describe("decodeSavedQueries", () => {
  it("qualifies the id, and the kind and signal words of the clauses", async () => {
    expect(
      await decode([
        buildQuery([
          { key: "signal", op: "is", value: "asked" },
          { key: "kind", op: "is", value: "ticket" },
          { key: "team", op: "is", value: "Checkout" },
          { key: "waiting", op: "over", value: 86400 },
          { key: "held", op: "is", value: false },
        ]),
      ]),
    ).toEqual([
      {
        id: "acme/mine",
        source: "acme",
        name: "Mine",
        order: "waiting",
        clauses: [
          { key: "signal", op: "is", value: "acme/asked" },
          { key: "kind", op: "is", value: "acme/ticket" },
          { key: "team", op: "is", value: "Checkout" },
          { key: "waiting", op: "over", value: 86400 },
          { key: "held", op: "is", value: false },
        ],
      },
    ]);
  });

  it.each([
    {
      name: "a signal word the plugin does not declare",
      clause: { key: "signal", op: "is", value: "ghost" },
      message: 'names "ghost", which the plugin does not declare as a signal kind',
    },
    {
      name: "an entity kind word the plugin does not declare",
      clause: { key: "kind", op: "is", value: "ghost" },
      message: 'names "ghost", which the plugin does not declare as an entity kind',
    },
    {
      name: "a key that is no core key and no declared field",
      clause: { key: "color", op: "is", value: "red" },
      message: 'the clause key "color" is neither',
    },
    {
      name: "over on a text field",
      clause: { key: "team", op: "over", value: 3 },
      message: 'uses "over", but that key takes "is"',
    },
    {
      name: "is on a duration",
      clause: { key: "waiting", op: "is", value: 3 },
      message: 'uses "is", but that key takes "over" or "under"',
    },
    {
      name: "a text value on a number field",
      clause: { key: "size", op: "over", value: "big" },
      message: "has a value that is not a number",
    },
    {
      name: "a text value on a boolean key",
      clause: { key: "flag", op: "is", value: "yes" },
      message: "has a value that is not a boolean",
    },
    {
      name: "a source",
      clause: { key: "mine", op: "is", value: true, source: "acme" },
      message: "remove source and connectionId",
    },
  ])("refuses $name", async ({ clause, message }) => {
    const refusal = await decode([buildQuery([clause as InboxClause])]);

    expect(refusal).toContain("the saved query mine of the event source tracker is invalid");
    expect(refusal).toContain(message);
  });

  it("lets an age field be compared with a duration in seconds", async () => {
    expect(
      Array.isArray(await decode([buildQuery([{ key: "opened", op: "over", value: 3600 }])])),
    ).toBe(true);
  });

  it("refuses more than eight clauses, an empty name and an unknown order", async () => {
    const clause: InboxClause = { key: "mine", op: "is", value: true };

    expect(await decode([buildQuery(Array.from({ length: 9 }, () => clause))])).toContain(
      "is invalid",
    );
    expect(await decode([buildQuery([], { name: "" })])).toContain("is invalid");
    expect(await decode([buildQuery([], { order: "oldest" as "newest" })])).toContain("is invalid");
  });

  it("refuses a word used twice, and a fifth query in a plugin", async () => {
    expect(await decode([buildQuery([]), buildQuery([])])).toContain("declares it twice");
    expect(
      await decode([buildQuery([], { word: "other" })], {
        ...CONTEXT,
        takenIds: new Set(["acme/mine"]),
      }),
    ).toHaveLength(1);
    expect(
      await decode([buildQuery([])], { ...CONTEXT, takenIds: new Set(["acme/mine"]) }),
    ).toContain("declares it twice");
    expect(
      await decode([buildQuery([], { word: "e" })], {
        ...CONTEXT,
        takenIds: new Set(["acme/a", "acme/b", "acme/c", "acme/d"]),
      }),
    ).toContain("more than 4 saved queries");
  });
});
