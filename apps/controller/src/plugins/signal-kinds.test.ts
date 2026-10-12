/**
 * Tests the limits `decodeSignalKinds` puts on a kind's match fields: a kind
 * declares at most `MAX_SIGNAL_MATCH_FIELDS`, each with a name of at most
 * `MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH` characters, so every Ignore Rule the
 * core offers from them can be created.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH, MAX_SIGNAL_MATCH_FIELDS } from "@hercule/contract";
import type { PluginManifest, SignalKindDeclaration, SignalMatchField } from "@hercule/plugin-host";
import { decodeSignalKinds } from "./signal-kinds";

const MANIFEST: PluginManifest = {
  id: "acme",
  displayName: "Acme",
  hostApi: 1,
  capabilities: ["event-sources"],
  configSchema: Schema.Struct({}),
};

/** Builds Acme's `asked` kind with those match fields. */
const buildDeclaration = (matchFields: ReadonlyArray<SignalMatchField>): SignalKindDeclaration => ({
  word: "asked",
  label: "Asked",
  description: "Someone asked.",
  from: ["acme.asked"],
  rule: '"yes"',
  guidance: "Raise it.",
  threadRef: "event.payload.thread",
  namesYou: true,
  priority: "normal",
  matchFields,
  ends: [],
  build: () => Effect.die("never built"),
});

/** Builds `count` match fields named `f0`, `f1` and so on. */
const buildMatchFields = (count: number): ReadonlyArray<SignalMatchField> =>
  Array.from({ length: count }, (_, index) => ({
    name: `f${String(index)}`,
    label: `Field ${String(index)}`,
    path: "event.payload.thread",
  }));

/** Decodes the one declaration, and returns `accepted` or the refusal's message. */
const decode = (matchFields: ReadonlyArray<SignalMatchField>) =>
  Effect.runPromise(
    Effect.match(
      decodeSignalKinds(
        MANIFEST,
        "desk",
        [buildDeclaration(matchFields)],
        new Set(["acme.asked"]),
        new Set(),
      ),
      { onFailure: (error) => error.message, onSuccess: () => "accepted" },
    ),
  );

describe("decodeSignalKinds", () => {
  it("accepts as many match fields as a rule can match on, with names of the longest length", async () => {
    const fields = buildMatchFields(MAX_SIGNAL_MATCH_FIELDS);
    const longName = "n".repeat(MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH);

    expect(await decode([...fields.slice(1), { ...fields[0]!, name: longName }])).toBe("accepted");
  });

  it("refuses a kind with more match fields than a rule can match on", async () => {
    expect(await decode(buildMatchFields(MAX_SIGNAL_MATCH_FIELDS + 1))).toContain(
      "the signal kind asked of the event source desk is invalid",
    );
  });

  it("refuses a match field whose name is empty or too long", async () => {
    const [field] = buildMatchFields(1);

    expect(await decode([{ ...field!, name: "" }])).toContain("is invalid");
    expect(
      await decode([{ ...field!, name: "n".repeat(MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH + 1) }]),
    ).toContain("is invalid");
  });
});
