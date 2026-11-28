import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HarnessDefinition } from "@hercule/plugin-host";
import {
  ATTACHMENTS_CAPABILITY,
  type CatalogModel,
  type ModelDescriptor,
  type ProbeResult,
} from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../db";
import {
  buildHarnessDefinition,
  buildProviderDefinition,
  createPluginFixture,
} from "../plugins/testing";
import { modelCatalogRepository } from "../provider-accounts";
import { addAccount, addRunner, addSnapshot, runWithAccounts } from "../provider-accounts/testing";
import {
  describeAttachmentRefusal,
  findAttachmentRefusal,
  type AttachmentRecipient,
} from "./attachment-refusal";

const MEBIBYTE = 1024 * 1024;

const buildModel = (slug: string, imageInput: ModelDescriptor["imageInput"]): ModelDescriptor => ({
  slug,
  name: slug,
  imageInput,
  options: [],
});

/** Returns `count` attachments of one MB each, named `1.png`, `2.png`, and so on. */
const buildAttachments = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `${String(index + 1)}.png`,
    sizeBytes: MEBIBYTE,
  }));

const recipient: AttachmentRecipient = {
  runnerName: "laptop",
  capabilities: [ATTACHMENTS_CAPABILITY],
  modelDescriptor: buildModel("opus", { maxBytes: null }),
  model: "opus",
};

const glm = buildModel("glm-5.3", null);
const pi = buildModel("pi", { maxBytes: 3.375 * MEBIBYTE });

describe("describeAttachmentRefusal", () => {
  it("lets images through to a model that accepts them on a runner that takes them", () => {
    expect(describeAttachmentRefusal(recipient, buildAttachments(3))).toBeUndefined();
  });

  it("refuses images for a runner that did not agree to the capability, before asking about the model", () => {
    expect(
      describeAttachmentRefusal(
        { ...recipient, capabilities: [], model: "glm-5.3", modelDescriptor: glm },
        buildAttachments(1),
      ),
    ).toBe(
      "Runner `laptop` runs an older Hercule that can't take images. " +
        "Update the runner or send the prompt without images.",
    );
  });

  it("refuses images for a model that does not accept them, counting the images", () => {
    expect(
      describeAttachmentRefusal(
        { ...recipient, model: "glm-5.3", modelDescriptor: glm },
        buildAttachments(2),
      ),
    ).toBe(
      "`glm-5.3` does not accept images. Remove the 2 images or pick a model that accepts them.",
    );
    expect(
      describeAttachmentRefusal(
        { ...recipient, model: "glm-5.3", modelDescriptor: glm },
        buildAttachments(1),
      ),
    ).toBe("`glm-5.3` does not accept images. Remove the image or pick a model that accepts them.");
  });

  it("refuses an image larger than the model's own limit, naming it, and lets one at the limit through", () => {
    const piRecipient = { ...recipient, model: "pi", modelDescriptor: pi };
    expect(
      describeAttachmentRefusal(piRecipient, [
        { name: "small.png", sizeBytes: MEBIBYTE },
        { name: "photo.png", sizeBytes: 4 * MEBIBYTE },
      ]),
    ).toBe(
      '"photo.png" is 4 MB; this model accepts images up to 3.375 MB. ' +
        "Send a smaller image or pick another model.",
    );
    expect(
      describeAttachmentRefusal(piRecipient, [{ name: "exact.png", sizeBytes: 3.375 * MEBIBYTE }]),
    ).toBeUndefined();
  });

  it("rounds an image just over the limit up, so the message never shows it as equal", () => {
    expect(
      describeAttachmentRefusal({ ...recipient, model: "pi", modelDescriptor: pi }, [
        { name: "edge.png", sizeBytes: 3.375 * MEBIBYTE + 1 },
      ]),
    ).toBe(
      '"edge.png" is 3.376 MB; this model accepts images up to 3.375 MB. ' +
        "Send a smaller image or pick another model.",
    );
  });

  it("refuses images for a model the runner did not report, because unknown is not yes", () => {
    expect(
      describeAttachmentRefusal(
        { ...recipient, model: "mystery", modelDescriptor: undefined },
        buildAttachments(1),
      ),
    ).toBe(
      "`mystery` is not in the models runner `laptop` reported, so Hercule can't tell " +
        "whether it accepts images. Send the prompt without images or pick another model.",
    );
  });
});

const WIDE = "wide/wide";
const NARROW = "narrow/narrow";
const API_PROVIDER = "apiprov/apiprov";

const runs = (models: "all" | "own-list") => [
  {
    providerId: API_PROVIDER,
    kinds: [{ kind: "api-key", modelArgument: "{model}" }],
    models,
  },
];

/**
 * A provider that reads its catalog from its API, and two harnesses: `wide`
 * runs any model of the provider, `narrow` only those it lists itself.
 */
const buildPlugins = () => {
  const harness = (id: string, supports: HarnessDefinition["runs"]) =>
    createPluginFixture({ id, definitions: [buildHarnessDefinition(id, supports)] }).plugin;
  return [
    harness("wide", runs("all")),
    harness("narrow", runs("own-list")),
    createPluginFixture({
      id: "apiprov",
      capabilities: ["providers"],
      definitions: [],
      providers: [
        {
          ...buildProviderDefinition("apiprov", [WIDE, NARROW]),
          catalogSource: {
            kind: "provider-api",
            url: "https://api.example.com/v1/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
        },
      ],
      providerOptions: { parseCatalogBody: () => [] },
    }).plugin,
  ];
};

const catalogModel = (slug: string, imageInput: CatalogModel["imageInput"]): CatalogModel => ({
  slug,
  name: slug,
  imageInput,
  options: [],
});

const catalog = [
  catalogModel("vision", { maxBytes: 2 * MEBIBYTE }),
  catalogModel("text-only", null),
  catalogModel("listed", null),
];

/** The harness lists `listed` itself, and as one that takes images. */
const listing: ProbeResult = {
  harnessVersion: "1.0.0",
  auth: { status: "ok" },
  models: [buildModel("listed", { maxBytes: null })],
  usage: null,
};

/**
 * Asks for the refusal of one image sent to `model` in `harnessId`, for an
 * account whose catalog is `catalog` and whose runner has listed `listing`.
 */
const refusalFor = (harnessId: string, model: string, sizeBytes = MEBIBYTE) =>
  runWithAccounts(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const account = yield* addAccount({ providerId: API_PROVIDER, defaultHarnessId: harnessId });
      yield* withTransaction(
        sql,
        (yield* modelCatalogRepository).recordSuccess(
          account.id,
          catalog,
          yield* nowIso,
          "2026-10-31T10:00:00.000Z",
        ),
      );
      const runnerId = yield* addRunner("laptop");
      yield* addSnapshot(account.id, harnessId, runnerId, listing);
      yield* withTransaction(
        sql,
        sql`
          UPDATE runners SET negotiated_capabilities = ${JSON.stringify([ATTACHMENTS_CAPABILITY])}
          WHERE id = ${uuidFromString(runnerId)}
        `,
      );
      return yield* findAttachmentRefusal({
        runnerId,
        providerAccountId: account.id,
        harnessId,
        model,
        attachments: [{ name: "photo.png", sizeBytes }],
      });
    }),
    undefined,
    buildPlugins(),
  );

describe("findAttachmentRefusal", () => {
  it("lets an image through to a model the harness lacks when the catalog says it takes images", async () => {
    expect(await refusalFor(WIDE, "vision")).toBeUndefined();
  });

  it("holds an image for a model the catalog declares to the catalog's size limit", async () => {
    expect(await refusalFor(WIDE, "vision", 3 * MEBIBYTE)).toBe(
      '"photo.png" is 3 MB; this model accepts images up to 2 MB. ' +
        "Send a smaller image or pick another model.",
    );
  });

  it("refuses an image for a model the harness lacks when the catalog says it takes none", async () => {
    expect(await refusalFor(WIDE, "text-only")).toContain("does not accept images");
  });

  it("describes a model the harness lists by what the harness says, not the catalog", async () => {
    expect(await refusalFor(WIDE, "listed")).toBeUndefined();
  });

  it("does not read the catalog for a harness that runs only the models it lists itself", async () => {
    expect(await refusalFor(NARROW, "vision")).toContain("is not in the models runner");
  });

  it("refuses a model neither the harness nor the catalog knows", async () => {
    expect(await refusalFor(WIDE, "mystery")).toContain("is not in the models runner");
  });
});
