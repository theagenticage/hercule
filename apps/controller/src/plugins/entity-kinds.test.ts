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
    {
      name: "a status icon with something other than path data",
      declarations: [
        buildKind("ticket", {
          status: {
            open: { shape: "ring", tone: "quiet", word: "Open", icon: { paths: ['M0 0"/>'] } },
          },
        }),
      ],
      taken: NOTHING_TAKEN,
      message: "something other than SVG path data",
    },
    {
      name: "a status with both a hue and a colour",
      declarations: [
        buildKind("ticket", {
          status: {
            open: { shape: "ring", tone: "quiet", word: "Open", hue: 140, color: "green" } as never,
          },
        }),
      ],
      taken: NOTHING_TAKEN,
      message: "status.open",
    },
    {
      name: "a status colour written as a CSS function",
      declarations: [
        buildKind("ticket", {
          status: { open: { shape: "ring", tone: "quiet", word: "Open", color: "rgb(0,0,0)" } },
        }),
      ],
      taken: NOTHING_TAKEN,
      message: "a hex code",
    },
    {
      name: "a status colour that is no CSS colour name",
      declarations: [
        buildKind("ticket", {
          status: {
            open: {
              shape: "ring",
              tone: "quiet",
              word: "Open",
              color: { light: "#fff", dark: "purpel" },
            },
          },
        }),
      ],
      taken: NOTHING_TAKEN,
      message:
        'the colour { light: "#fff", dark: "purpel" } of its status "open" is not a CSS colour',
    },
  ])("refuses $name", async ({ declarations, taken, message }) => {
    expect(await decode(declarations, taken)).toContain(message);
  });

  describe("fields and card face", () => {
    const text = (key: string, extra: Record<string, unknown> = {}) =>
      ({ key, label: key, type: "text", ...extra }) as const;
    const project = buildKind("project", { pace: "context" });

    it("returns a full declaration with each facet.values qualified with the plugin id", async () => {
      const kinds = await decode([
        buildKind("ticket", {
          plural: "Tickets",
          lasting: 1,
          fields: [
            text("team", { facet: { plural: "Teams", values: "project" } }),
            { key: "priority", label: "Priority", type: "enum", values: [{ value: "high" }] },
            { key: "estimate", label: "Estimate", type: "money", currency: "EUR" },
            { key: "opened", label: "Opened", type: "age" },
          ],
          face: { place: "team", context: "priority", fact: "estimate" },
        }),
        project,
      ]);

      expect(kinds).toMatchObject([
        {
          plural: "Tickets",
          lasting: 1,
          fields: [
            { key: "team", facet: { plural: "Teams", values: "acme/project" } },
            { key: "priority" },
            { key: "estimate" },
            { key: "opened" },
          ],
          face: { place: "team", context: "priority", fact: "estimate" },
        },
        { word: "acme/project" },
      ]);
    });

    it.each([
      {
        name: "a field key declared twice in a kind",
        declarations: [buildKind("ticket", { fields: [text("team"), text("team")] })],
        message:
          'acme/ticket of the event source tracker is invalid: its field "team" is declared twice',
      },
      {
        name: "more than 16 fields",
        declarations: [
          buildKind("ticket", {
            fields: Array.from({ length: 17 }, (_, index) => text(`field-${String(index)}`)),
          }),
        ],
        message: "at most 16",
      },
      {
        name: "an enum that lists a value twice",
        declarations: [
          buildKind("ticket", {
            fields: [
              { key: "p", label: "P", type: "enum", values: [{ value: "a" }, { value: "a" }] },
            ],
          }),
        ],
        message: 'lists the value "a" twice',
      },
      {
        name: "a facet on a number field",
        declarations: [
          buildKind("ticket", {
            fields: [{ key: "n", label: "N", type: "number", facet: { plural: "Ns" } }],
          }),
        ],
        message: 'its field "n" has a facet, but its type is "number"',
      },
      {
        name: "facet values that name a kind that is not a context kind",
        declarations: [
          buildKind("ticket", {
            fields: [text("team", { facet: { plural: "Teams", values: "other" } })],
          }),
          buildKind("other"),
        ],
        message: 'name "other", which is not a context kind',
      },
      {
        name: "facet values that name no kind of the source",
        declarations: [
          buildKind("ticket", {
            fields: [text("team", { facet: { plural: "Teams", values: "missing" } })],
          }),
        ],
        message: 'name "missing", which is not a context kind',
      },
      {
        name: "a face on a context kind",
        declarations: [
          buildKind("project", { pace: "context", fields: [text("a")], face: { place: "a" } }),
        ],
        message: "a context kind has no card",
      },
      {
        name: "a face slot that names no declared field",
        declarations: [buildKind("ticket", { fields: [text("a")], face: { place: "b" } })],
        message: 'its face place is "b", which is not a field the kind declares',
      },
      {
        name: "a face place on a number field",
        declarations: [
          buildKind("ticket", {
            fields: [{ key: "n", label: "N", type: "number" }],
            face: { place: "n" },
          }),
        ],
        message: 'its face place is the field "n", whose type is "number"',
      },
      {
        name: "a face context on a bool field",
        declarations: [
          buildKind("ticket", {
            fields: [{ key: "b", label: "B", type: "bool" }],
            face: { context: "b" },
          }),
        ],
        message: 'its face context is the field "b", whose type is "bool"',
      },
      {
        name: "a face fact on a text field",
        declarations: [buildKind("ticket", { fields: [text("a")], face: { fact: "a" } })],
        message: 'its face fact is the field "a", whose type is "text"',
      },
      {
        name: "one key declared by two kinds with a different type",
        declarations: [
          buildKind("ticket", { fields: [text("size")] }),
          buildKind("epic", { fields: [{ key: "size", label: "size", type: "number" }] }),
        ],
        message: 'its field "size" is declared differently from the same key in ticket',
      },
      {
        name: "one key declared by two kinds with a different label",
        declarations: [
          buildKind("ticket", { fields: [text("size", { label: "Size" })] }),
          buildKind("epic", { fields: [text("size", { label: "Bulk" })] }),
        ],
        message: 'its field "size" is declared differently from the same key in ticket',
      },
      {
        name: "one key declared by two kinds with different enum values",
        declarations: [
          buildKind("ticket", {
            fields: [{ key: "p", label: "P", type: "enum", values: [{ value: "a" }] }],
          }),
          buildKind("epic", {
            fields: [{ key: "p", label: "P", type: "enum", values: [{ value: "b" }] }],
          }),
        ],
        message: 'its field "p" is declared differently from the same key in ticket',
      },
      {
        name: "facet values on a field that is not text",
        declarations: [
          buildKind("ticket", {
            fields: [
              {
                key: "p",
                label: "P",
                type: "enum",
                values: [{ value: "a" }],
                facet: { plural: "Ps", values: "project" },
              },
            ],
          }),
          buildKind("project", { pace: "context" }),
        ],
        message: 'has facet values from the context kind "project", but its type is "enum"',
      },
    ])("refuses $name", async ({ declarations, message }) => {
      expect(await decode(declarations)).toContain(message);
    });

    it.each([
      { name: "a lasting above 3", overrides: { lasting: 4 } },
      { name: "a fractional lasting", overrides: { lasting: 1.5 } },
      {
        name: "a bad currency",
        overrides: { fields: [{ key: "m", label: "M", type: "money", currency: "eur" }] },
      },
      { name: "a field key with a space", overrides: { fields: [text("a b")] } },
      {
        name: "an enum with no values",
        overrides: { fields: [{ key: "e", label: "E", type: "enum", values: [] }] },
      },
    ])("refuses $name", async ({ overrides }) => {
      expect(
        await decode([buildKind("ticket", overrides as Partial<EntityKindDeclaration>)]),
      ).toContain("the entity kind acme/ticket of the event source tracker is invalid");
    });

    it("lets two kinds declare the same key with the same type and label", async () => {
      const kinds = await decode([
        buildKind("ticket", { fields: [text("team")] }),
        buildKind("epic", { fields: [text("team")] }),
      ]);
      expect(Array.isArray(kinds)).toBe(true);
    });

    const priority = {
      key: "priority",
      label: "Priority",
      type: "enum",
      values: [{ value: "high" }],
    } as const;
    const flag = { key: "flag", label: "Flag", type: "bool" } as const;
    const opened = { key: "opened", label: "Opened", type: "age" } as const;
    const size = { key: "size", label: "Size", type: "number" } as const;

    it.each([
      { form: "bars", field: priority, type: "enum" },
      { form: "count", field: flag, type: "bool" },
      { form: "delta", field: size, type: "number" },
      { form: "date", field: size, type: "number" },
    ])("refuses a $form fact on a field of type $type", async ({ form, field }) => {
      const fact = form === "count" ? { form, unit: "file" } : { form };
      const message = await decode([
        buildKind("ticket", {
          fields: [field],
          facts: [{ field: field.key, ...fact }] as EntityKindDeclaration["facts"],
        }),
      ]);
      expect(message).toContain(
        `its ${form} fact reads the field "${field.key}", whose type is "${field.type}"`,
      );
    });

    it.each([
      { form: "bars", field: size },
      { form: "word", field: priority },
      { form: "money", field: flag },
      { form: "date", field: opened },
    ])("lets a $form fact read a field of type $field.type", async ({ form, field }) => {
      const kinds = await decode([
        buildKind("ticket", {
          fields: [field],
          facts: [{ field: field.key, form }] as EntityKindDeclaration["facts"],
        }),
      ]);
      expect(Array.isArray(kinds)).toBe(true);
    });

    it("lets a fact name a key that is no declared field", async () => {
      const kinds = await decode([
        buildKind("ticket", { facts: [{ field: "size", form: "bars" }] }),
      ]);
      expect(Array.isArray(kinds)).toBe(true);
    });
  });

  it("returns status colours as hex codes, and icons and hues as declared", async () => {
    const icon = { paths: ["M0 0h16v16H0z"] };
    const kinds = await decode([
      buildKind("ticket", {
        status: {
          open: { shape: "ring", tone: "quiet", word: "Open", icon, color: "green" },
          done: {
            shape: "check",
            tone: "good",
            word: "Done",
            color: { light: "#8250DF", dark: "plum" },
          },
          later: { shape: "dashed", tone: "quiet", word: "Later", hue: 85 },
        },
      }),
    ]);

    expect(kinds).toMatchObject([
      {
        status: {
          open: { icon, color: "#008000" },
          done: { color: { light: "#8250df", dark: "#dda0dd" } },
          later: { hue: 85 },
        },
      },
    ]);
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
