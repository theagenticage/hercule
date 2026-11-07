/**
 * Tests what recognition does with an observation before the External Entities
 * ingest decodes it: it searches only what fits the bounds, and searches the
 * same address or text once.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  MAX_ENTITY_TEXT_LENGTH,
  type EntityObservation,
  type EntityRecognition,
} from "@hercule/plugin-host";
import { MAX_TARGETS_PER_TEXT, recognizeClaims, type RecognizeText } from "./claim-recognition";

/** Builds a recognizer over one fake plugin, and records every text it was asked about. */
const buildRecognizer = (answer: (text: string) => ReadonlyArray<EntityRecognition>) => {
  const asked: Array<string> = [];
  const recognize: RecognizeText = (text) => {
    asked.push(text);
    return Effect.succeed(answer(text).map((recognition) => ({ pluginId: "forge", recognition })));
  };
  return { asked, recognize };
};

const observation = (extra: Record<string, unknown>): EntityObservation =>
  ({ kind: "item", ref: "tracker:item:1", title: "One", ...extra }) as unknown as EntityObservation;

const AS_REF: EntityRecognition = {
  recognized: "ref",
  form: "url",
  ref: "forge:item:7",
  kind: "forge/item",
};

describe("recognizeClaims", () => {
  it("takes the first recognition of form url for an address, and none when nothing recognizes it", async () => {
    const { recognize } = buildRecognizer((text) =>
      text.includes("forge") ? [{ ...AS_REF, form: "identifier" }, AS_REF] : [],
    );
    const claims = await Effect.runPromise(
      recognizeClaims(
        [
          observation({
            relations: {
              complete: true,
              partOf: [],
              linked: [],
              linkedUrls: ["https://forge.example/7", "https://nobody.example/x"],
            },
          }),
        ],
        recognize,
      ),
    );

    expect(claims.get("tracker:item:1")?.urls).toEqual([
      { url: "https://forge.example/7", target: { recognized: "ref", ref: "forge:item:7" } },
      { url: "https://nobody.example/x" },
    ]);
  });

  it("does not search an observation that breaks a bound, and the ingest refuses it later", async () => {
    const { asked, recognize } = buildRecognizer(() => [AS_REF]);
    const fourTexts = [1, 2, 3, 4].map((n) => ({ evidenceKey: `k${n}`, text: "x" }));
    const tooLong = [{ evidenceKey: "k", text: "x".repeat(MAX_ENTITY_TEXT_LENGTH + 1) }];
    const notAnAddress = { complete: true, partOf: [], linked: [], linkedUrls: ["javascript:1"] };
    const claims = await Effect.runPromise(
      recognizeClaims(
        [
          observation({ ref: "tracker:item:1", texts: fourTexts }),
          observation({ ref: "tracker:item:2", texts: tooLong }),
          observation({ ref: "tracker:item:3", relations: notAnAddress }),
          observation({ ref: "tracker:item:4", texts: "not a list" }),
        ],
        recognize,
      ),
    );

    expect(asked).toEqual([]);
    expect(claims.size).toBe(0);
  });

  it("searches an address or a text that several observations carry once, and drops a ref that is not one", async () => {
    const { asked, recognize } = buildRecognizer((text) =>
      text === "same"
        ? [AS_REF, { ...AS_REF, ref: "unresolved:sneaky" }, { ...AS_REF, ref: "has space" }]
        : [],
    );
    const claims = await Effect.runPromise(
      recognizeClaims(
        [1, 2].map((n) =>
          observation({ ref: `tracker:item:${n}`, texts: [{ evidenceKey: "d", text: "same" }] }),
        ),
        recognize,
      ),
    );

    expect(asked).toEqual(["same"]);
    expect(claims.get("tracker:item:2")?.texts).toEqual([
      { evidenceKey: "d", targets: [{ recognized: "ref", ref: "forge:item:7" }] },
    ]);
  });

  it("keeps at most the most targets one text may name", async () => {
    const many: Array<EntityRecognition> = Array.from(
      { length: MAX_TARGETS_PER_TEXT + 5 },
      (_, n) => ({
        recognized: "scoped",
        form: "identifier",
        identifier: `OPS-${n}`,
      }),
    );
    const { recognize } = buildRecognizer(() => many);
    const claims = await Effect.runPromise(
      recognizeClaims([observation({ texts: [{ evidenceKey: "d", text: "x" }] })], recognize),
    );

    expect(claims.get("tracker:item:1")?.texts[0]?.targets).toHaveLength(MAX_TARGETS_PER_TEXT);
  });
  it("does not search a text whose revision equals the stored one, and reads the stored revisions once", async () => {
    const { asked, recognize } = buildRecognizer(() => [AS_REF]);
    const reads: Array<ReadonlyArray<string>> = [];
    const claims = await Effect.runPromise(
      recognizeClaims(
        [
          observation({
            ref: "tracker:item:1",
            texts: [
              { evidenceKey: "description", text: "unchanged", revision: "r1" },
              { evidenceKey: "notes", text: "edited", revision: "n2" },
            ],
          }),
          observation({
            ref: "tracker:item:2",
            texts: [{ evidenceKey: "description", text: "no revision" }],
          }),
        ],
        recognize,
        (refs) => {
          reads.push(refs);
          return Effect.succeed(
            new Map([
              [
                "tracker:item:1",
                new Map([
                  ["description", "r1"],
                  ["notes", "n1"],
                ]),
              ],
            ]),
          );
        },
      ),
    );

    expect(reads).toEqual([["tracker:item:1"]]);
    expect(asked).toEqual(["edited", "no revision"]);
    expect(claims.get("tracker:item:1")?.texts).toEqual([
      { evidenceKey: "description", revision: "r1" },
      {
        evidenceKey: "notes",
        revision: "n2",
        targets: [{ recognized: "ref", ref: "forge:item:7" }],
      },
    ]);
  });

  it("does not search an observation whose revision is longer than the schema allows", async () => {
    const { asked, recognize } = buildRecognizer(() => [AS_REF]);
    const claims = await Effect.runPromise(
      recognizeClaims(
        [
          observation({
            texts: [{ evidenceKey: "d", text: "x", revision: "r".repeat(257) }],
          }),
        ],
        recognize,
      ),
    );

    expect(asked).toEqual([]);
    expect(claims.size).toBe(0);
  });
});
