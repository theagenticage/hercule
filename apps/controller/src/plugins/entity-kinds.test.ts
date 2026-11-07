/**
 * Tests the load-time check of an event source's entity kinds: a valid table
 * is qualified with the plugin's id, and each mistake refuses the source with
 * a message that names the kind.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TASK_STAGES } from "@hercule/contract";
import {
  ENTITY_STATUS_STAGES,
  type EntityKindDeclaration,
  type EventSourceContribution,
  type PluginManifest,
} from "@hercule/plugin-host";
import { decodeEntityKinds, type TakenEntityKinds } from "./entity-kinds";
import { registerEventSourceContribution, type RegisteredEventSource } from "./event-sources";

const MANIFEST: PluginManifest = {
  id: "acme",
  displayName: "Acme",
  hostApi: 8,
  capabilities: ["event-sources", "events", "entities"],
  configSchema: Schema.Struct({}),
};

/** Builds a kind named `word` in the invented Acme tracker, with the fields the test changes. */
const buildKind = (
  word: string,
  overrides: Partial<EntityKindDeclaration> = {},
): EntityKindDeclaration => ({
  word,
  noun: "Ticket",
  refPrefix: `acme:${word}:`,
  pace: "slow",
  patience: 48,
  identifier: "{key}",
  person: "assignee",
  owner: "assignee",
  status: { open: { shape: "ring", tone: "quiet", word: "Open", stage: "exploring" } },
  facts: [],
  reasons: { assigned: { say: "Assigned to you", tone: "plain" } },
  ...overrides,
});

const NOTHING_TAKEN: TakenEntityKinds = { words: new Set(), refPrefixes: [] };

/** Decodes the declarations, and returns the qualified kinds or the refusal's message. */
const decode = (
  declarations: ReadonlyArray<EntityKindDeclaration>,
  taken: TakenEntityKinds = NOTHING_TAKEN,
) =>
  Effect.runPromise(
    Effect.match(decodeEntityKinds(MANIFEST, "tracker", declarations, taken), {
      onFailure: (error) => error.message,
      onSuccess: (kinds) => kinds,
    }),
  );

describe("decodeEntityKinds", () => {
  it("returns the kinds with their word, home and section qualified with the plugin id", async () => {
    const kinds = await decode([
      buildKind("ticket", { home: "project", section: "milestone" }),
      buildKind("project", { pace: "context", groupable: { caption: "Acme project" } }),
      buildKind("milestone", { pace: "context" }),
    ]);

    expect(kinds).toMatchObject([
      { word: "acme/ticket", home: "acme/project", section: "acme/milestone" },
      { word: "acme/project" },
      { word: "acme/milestone" },
    ]);
  });

  it.each([
    {
      name: "a word declared twice in the source",
      declarations: [buildKind("ticket"), buildKind("ticket", { refPrefix: "acme:other:" })],
      taken: NOTHING_TAKEN,
      message: "acme/ticket is declared twice",
    },
    {
      name: "a word another source of the plugin declared",
      declarations: [buildKind("ticket")],
      taken: { words: new Set(["acme/ticket"]), refPrefixes: [] },
      message: "acme/ticket is declared twice",
    },
    {
      name: "a refPrefix that is the same as another kind's",
      declarations: [
        buildKind("a", { refPrefix: "acme:t:" }),
        buildKind("b", { refPrefix: "acme:t:" }),
      ],
      taken: NOTHING_TAKEN,
      message: "overlaps the refPrefix",
    },
    {
      name: "a refPrefix that starts with another kind's",
      declarations: [
        buildKind("a", { refPrefix: "acme:t:" }),
        buildKind("b", { refPrefix: "acme:t:x:" }),
      ],
      taken: NOTHING_TAKEN,
      message: "overlaps the refPrefix",
    },
    {
      name: "a refPrefix another plugin's kind starts with",
      declarations: [buildKind("ticket", { refPrefix: "zed:" })],
      taken: {
        words: new Set<string>(),
        refPrefixes: [{ kind: "zed/doc", refPrefix: "zed:doc:" }],
      },
      message: 'overlaps the refPrefix "zed:doc:" of zed/doc',
    },
    {
      name: "an identifier template with no placeholder",
      declarations: [buildKind("ticket", { identifier: "Ticket" })],
      taken: NOTHING_TAKEN,
      message: "at least one {field} placeholder",
    },
    {
      name: "an identifier template with an empty placeholder",
      declarations: [buildKind("ticket", { identifier: "#{}" })],
      taken: NOTHING_TAKEN,
      message: "at least one {field} placeholder",
    },
    {
      name: "an identifier template with a stray brace",
      declarations: [buildKind("ticket", { identifier: "{key} {" })],
      taken: NOTHING_TAKEN,
      message: "braces only for placeholders",
    },
    {
      name: "a home that names no declared kind",
      declarations: [buildKind("ticket", { home: "project" })],
      taken: NOTHING_TAKEN,
      message: 'its home is "project", which is not a kind this source declares',
    },
    {
      name: "a section that names no declared kind",
      declarations: [buildKind("ticket", { section: "milestone" })],
      taken: NOTHING_TAKEN,
      message: 'its section is "milestone", which is not a kind this source declares',
    },
    {
      name: "a status stage that is not a Task stage",
      declarations: [
        buildKind("ticket", {
          status: {
            open: { shape: "ring", tone: "quiet", word: "Open", stage: "shipped" as never },
          },
        }),
      ],
      taken: NOTHING_TAKEN,
      message: "status.open.stage",
    },
    {
      name: "a status shape outside the fixed set",
      declarations: [
        buildKind("ticket", {
          status: { open: { shape: "star" as never, tone: "quiet", word: "Open" } },
        }),
      ],
      taken: NOTHING_TAKEN,
      message: "is invalid",
    },
    {
      name: "more than three facts",
      declarations: [
        buildKind("ticket", {
          facts: ["a", "b", "c", "d"].map((field) => ({ field, form: "word" as const })),
        }),
      ],
      taken: NOTHING_TAKEN,
      message: "is invalid",
    },
    {
      name: "a count fact with no unit",
      declarations: [buildKind("ticket", { facts: [{ field: "files", form: "count" as never }] })],
      taken: NOTHING_TAKEN,
      message: "facts",
    },
  ])("refuses $name", async ({ declarations, taken, message }) => {
    expect(await decode(declarations, taken)).toContain(message);
  });

  it("lets a status map to exactly the stages a Task has", () => {
    expect([...ENTITY_STATUS_STAGES]).toEqual([...TASK_STAGES]);
  });
});

describe("registerEventSourceContribution with entity kinds", () => {
  const buildSource = (
    overrides: Partial<EventSourceContribution> = {},
  ): EventSourceContribution => ({
    id: "tracker",
    connectionType: "acme/tracker",
    kinds: {},
    feeds: { entities: { defaultIntervalSeconds: 120 } },
    open: () => Effect.die("never opened"),
    ...overrides,
  });

  /** Registers the source for a plugin with these capabilities, and returns the refusal or `registered`. */
  const register = (
    capabilities: PluginManifest["capabilities"],
    contribution: EventSourceContribution,
  ) =>
    Effect.runPromise(
      Effect.match(
        registerEventSourceContribution(
          { ...MANIFEST, capabilities },
          contribution,
          [],
          new Map(),
          [],
          [],
        ),
        { onFailure: (error) => error.message, onSuccess: () => "registered" },
      ),
    );

  it("refuses entity kinds without the entities capability", async () => {
    expect(
      await register(
        ["event-sources", "events"],
        buildSource({ entityKinds: [buildKind("ticket")] }),
      ),
    ).toContain("did not request the entities capability");
  });

  it("refuses an entity lookup without the entities capability", async () => {
    expect(
      await register(
        ["event-sources", "events"],
        buildSource({
          entityLookup: {
            recognize: () => [],
            search: () => Effect.succeed([]),
            resolve: () => Effect.succeed({ missing: "unknown" }),
          },
        }),
      ),
    ).toContain("did not request the entities capability");
  });

  it("refuses a second source of one plugin that declares an entity lookup", async () => {
    const lookup = {
      recognize: () => [],
      search: () => Effect.succeed([]),
      resolve: () => Effect.succeed({ missing: "unknown" as const }),
    };
    const sources: Array<RegisteredEventSource> = [];
    const registerNext = (id: string, connectionType: string, withLookup: boolean) =>
      Effect.runPromise(
        Effect.match(
          registerEventSourceContribution(
            MANIFEST,
            buildSource({ id, connectionType, ...(withLookup ? { entityLookup: lookup } : {}) }),
            [],
            new Map(),
            sources,
            [],
          ),
          { onFailure: (error) => error.message, onSuccess: () => "registered" },
        ),
      );

    expect(await registerNext("first", "acme/first", true)).toBe("registered");
    // A source with no lookup beside a source with one is fine.
    expect(await registerNext("plain", "acme/plain", false)).toBe("registered");
    expect(await registerNext("second", "acme/second", true)).toContain(
      "both declare an entityLookup",
    );
  });

  it("registers entity kinds when the capability is requested", async () => {
    expect(
      await register(
        ["event-sources", "events", "entities"],
        buildSource({ entityKinds: [buildKind("ticket")] }),
      ),
    ).toBe("registered");
  });
});
