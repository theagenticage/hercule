/**
 * Tests the registration pass of `PluginHost.boot`, through `Plugins.query`
 * and `Plugins.read`:
 *
 * - what the catalog holds after a boot;
 * - what a second boot on the same database changes;
 * - what a plugin that cannot be loaded, or whose `register` fails, leaves
 *   behind.
 *
 * Nothing is mocked.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  HOST_API,
  PluginError,
  registerConnectionType,
  registerEventSource,
  type AccountKind,
  type FeedDeclaration,
  type ParseUsageBody,
  type Plugin,
  type PluginCapability,
  type ProviderDefinition,
  type ProviderRegistrationOptions,
  type HarnessDefinition,
  type HarnessProviderSupport,
  type WorkflowActionContribution,
} from "@hercule/plugin-host";
import { HarnessHome } from "@hercule/protocol";
import { withTransaction } from "../db";
import { PluginHost, Plugins } from "./index";
import { pluginRepository } from "./repository";
import {
  asUser,
  buildActionPlugin,
  createPluginFixture,
  NOTE_APPEND_ACTION,
  notesPlugin,
  buildPluginStack,
  buildHarnessDefinition,
  buildProviderDefinition,
  IDLE_FEEDS,
  IDLE_INGEST_OPEN,
} from "./testing";

/** Runs an effect on a fresh plugin stack, as the user, like a request through the API. */
const run = <A, E>(body: Effect.Effect<A, E, Plugins | PluginHost | SqlClient.SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(buildPluginStack()), asUser));

const findDetail = <T extends { readonly id: string }>(details: ReadonlyArray<T>, id: string) =>
  details.find((detail) => detail.id === id);

/** What two fixture harnesses run, so a test can tell their catalog rows apart. */
const RUNS_ALPHA: HarnessProviderSupport = {
  providerId: "vendor/vendor",
  kinds: [{ kind: "api-key", credentialVariable: "ALPHA_KEY" }],
  modelArgument: "{model}",
  models: "all",
};
const RUNS_BETA: HarnessProviderSupport = {
  providerId: "vendor/vendor",
  kinds: [{ kind: "api-key", credentialVariable: "BETA_KEY" }],
  modelArgument: "beta/{model}",
  models: "own-list",
};

describe("PluginHost.boot on an empty database", () => {
  it("lists every registry plugin enabled, unconfigured, with its one contribution", async () => {
    const alpha = createPluginFixture({
      id: "alpha",
      definitions: [buildHarnessDefinition("alpha", [RUNS_ALPHA])],
    });
    const beta = createPluginFixture({
      id: "beta",
      definitions: [buildHarnessDefinition("beta", [RUNS_BETA])],
    });

    const details = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([alpha.plugin, beta.plugin]));
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
      }),
    );

    expect(details.map((detail) => detail.id)).toEqual(["alpha", "beta"]);

    for (const [id, runs] of [
      ["alpha", RUNS_ALPHA],
      ["beta", RUNS_BETA],
    ] as const) {
      const detail = findDetail(details, id);
      expect(detail?.enabled).toBe(true);
      expect(detail?.config).toEqual({});
      expect(detail?.contributions).toHaveLength(1);
      const contribution = detail?.contributions[0];
      expect(contribution?.extensionPoint).toBe("harness");
      expect(contribution?.id).toBe(`${id}/${id}`);
      expect(contribution?.definition).toMatchObject({ id: `${id}/${id}`, runs: [runs] });
    }
  });
});

describe("a second PluginHost.boot on the same database", () => {
  it("lists only the plugins still in the registry, each contribution once", async () => {
    const alpha = createPluginFixture({ id: "alpha" });
    const beta = createPluginFixture({ id: "beta" });

    const details = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        yield* host.boot([beta.plugin]);
        const repository = yield* pluginRepository;
        return {
          listed: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
          catalog: yield* repository.contributions(),
        };
      }),
    );

    expect(details.listed.map((detail) => detail.id)).toEqual(["beta"]);
    expect(findDetail(details.listed, "beta")?.contributions).toHaveLength(1);
    expect(details.catalog.get("alpha")).toBeUndefined();
  });

  it("keeps a plugin disabled between boots", async () => {
    const alpha = createPluginFixture({ id: "alpha" });
    const beta = createPluginFixture({ id: "beta" });

    const details = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([alpha.plugin, beta.plugin]);
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(sql, sql`UPDATE plugins SET enabled = 0 WHERE id = 'alpha'`);
        yield* host.boot([alpha.plugin, beta.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
      }),
    );

    expect(findDetail(details, "alpha")?.enabled).toBe(false);
    expect(findDetail(details, "beta")?.enabled).toBe(true);
  });
});

describe("a plugin built against another host API version", () => {
  it("gets the refused status with both versions, is never registered, and has no contributions", async () => {
    const future = createPluginFixture({ id: "future", hostApi: HOST_API + 1 });

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([future.plugin]);
        return {
          status: yield* host.status("future"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("future")),
        };
      }),
    );

    expect(future.hosts).toEqual([]);
    expect(Option.getOrNull(status)).toEqual({
      _tag: "refused",
      reason: { kind: "hostApi", expected: HOST_API, actual: HOST_API + 1 },
    });
    expect(detail.status).toEqual({
      _tag: "refused",
      reason: { kind: "hostApi", expected: HOST_API, actual: HOST_API + 1 },
    });
    expect(detail.contributions).toEqual([]);
  });
});

describe("a plugin the host cannot load", () => {
  it("gets the refused status for an unimplemented capability and for a config schema no form can render", async () => {
    const channels = createPluginFixture({ id: "channels-plugin", capabilities: ["channels"] });
    const nested = createPluginFixture({
      id: "nested-plugin",
      configSchema: Schema.Struct({ server: Schema.Struct({ host: Schema.String }) }),
    });

    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([channels.plugin, nested.plugin]);
        return {
          channels: yield* host.status("channels-plugin"),
          nested: yield* host.status("nested-plugin"),
        };
      }),
    );

    expect(Option.getOrNull(statuses.channels)).toEqual({
      _tag: "refused",
      reason: { kind: "unimplementedCapability", capability: "channels" },
    });

    const nestedStatus = Option.getOrNull(statuses.nested) as {
      readonly _tag: string;
      readonly reason: { readonly kind: string; readonly message: string };
    } | null;
    expect(nestedStatus?._tag).toBe("refused");
    expect(nestedStatus?.reason.kind).toBe("unsupportedConfigSchema");
    expect(nestedStatus?.reason.message.length).toBeGreaterThan(0);

    expect(channels.hosts).toEqual([]);
    expect(nested.hosts).toEqual([]);
  });
});

describe("a plugin whose register fails", () => {
  it("is errored with its own message, holds no contributions, and is never activated", async () => {
    const broken = createPluginFixture({
      id: "broken",
      registerFails: "the harness binary is missing",
    });

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([broken.plugin]);
        return {
          status: yield* host.status("broken"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("broken")),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("the harness binary is missing");
    expect(detail.contributions).toEqual([]);
    expect(broken.calls).toEqual([]);
  });

  it("is errored, naming the path, when a contribution contains a function", async () => {
    const definition = {
      ...buildHarnessDefinition("callback"),
      displayName: (() => undefined) as unknown as string,
    };
    const callback = createPluginFixture({ id: "callback", definitions: [definition] });

    const { status, detail } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([callback.plugin]);
        return {
          status: yield* host.status("callback"),
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("callback")),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("displayName");
    expect(detail.contributions).toEqual([]);
    expect(callback.calls).toEqual([]);
  });

  it("is errored, keeping every other plugin's rows, when it registers one id twice", async () => {
    const twice = createPluginFixture({
      id: "twice",
      definitions: [buildHarnessDefinition("same"), buildHarnessDefinition("same")],
    });
    const other = createPluginFixture({ id: "other" });

    const { status, details } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([twice.plugin, other.plugin]);
        return {
          status: yield* host.status("twice"),
          details: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toContain("harness");
    expect(errored?.message).toContain("twice/same");
    expect(findDetail(details, "twice")?.contributions).toEqual([]);
    expect(findDetail(details, "other")?.contributions).toHaveLength(1);
  });

  it("loads two plugins that register the same harness word, under distinct qualified ids", async () => {
    const first = createPluginFixture({
      id: "first",
      definitions: [buildHarnessDefinition("claude-code", [RUNS_ALPHA])],
    });
    const second = createPluginFixture({
      id: "second",
      definitions: [buildHarnessDefinition("claude-code", [RUNS_BETA])],
    });

    const { statuses, catalogIds, live } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([first.plugin, second.plugin]);
        const details = yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
        return {
          statuses: details.map((detail) => detail.status._tag),
          catalogIds: details.flatMap((detail) => detail.contributions.map((one) => one.id)),
          live: yield* host.harnesses(),
        };
      }),
    );

    expect(statuses).toEqual(["active", "active"]);
    expect(catalogIds).toEqual(["first/claude-code", "second/claude-code"]);
    // The live definitions carry the same ids as the catalog rows, so a stored
    // account finds its definition by either.
    expect(live.map((definition) => [definition.id, definition.runs])).toEqual([
      ["first/claude-code", [RUNS_ALPHA]],
      ["second/claude-code", [RUNS_BETA]],
    ]);
  });

  it("is errored when its harness's display name is longer than the catalog allows", async () => {
    const shouty = createPluginFixture({
      id: "shouty",
      definitions: [{ ...buildHarnessDefinition("shouty"), displayName: "S".repeat(129) }],
    });

    const detail = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([shouty.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.read("shouty"));
      }),
    );

    expect(detail.status._tag).toBe("errored");
    expect(detail.contributions).toEqual([]);
  });

  it("accepts a qualified harness id of exactly the longest allowed length and refuses one character more", async () => {
    // A plugin id and a harness word may each be 64 characters, so the
    // longest qualified id is 129 characters, one more than the 128 the
    // column that stores it holds.
    const fits = createPluginFixture({
      id: "p".repeat(63),
      definitions: [{ ...buildHarnessDefinition("a".repeat(64)), displayName: "Fits" }],
    });
    const tooLong = createPluginFixture({
      id: "q".repeat(64),
      definitions: [{ ...buildHarnessDefinition("a".repeat(64)), displayName: "Too long" }],
    });
    const other = createPluginFixture({ id: "other" });

    const { statuses, harnessIds, contributions } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([fits.plugin, tooLong.plugin, other.plugin]);
        const details = yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
        return {
          statuses: details.map((detail) => detail.status),
          harnessIds: (yield* host.harnesses()).map((definition) => definition.id),
          contributions: details.map((detail) => detail.contributions.length),
        };
      }),
    );

    expect(statuses.map((status) => status._tag)).toEqual(["active", "errored", "active"]);
    const refusal = statuses[1];
    expect(refusal?._tag === "errored" ? refusal.message : "").toContain(
      "129 characters long, and the limit is 128",
    );
    expect(harnessIds).toEqual([`${"p".repeat(63)}/${"a".repeat(64)}`, "other/other"]);
    expect(contributions).toEqual([1, 0, 1]);
  });

  it.each([
    ["a space", "my harness"],
    ["a leading dash", "-harness"],
    ["a leading dot", ".harness"],
    ["a path separator", "a/b"],
    ["an accent", "hârness"],
    ["65 characters", "a".repeat(65)],
  ])("is errored when the harness id has %s, because it names a folder", async (_label, word) => {
    const message = await bootAndReadError(
      createPluginFixture({ id: "folder", definitions: [buildHarnessDefinition(word)] }).plugin,
    );

    expect(message).toContain("Harness Home");
  });

  it("is errored when the plugin id is too long to name a folder, and says so", async () => {
    const message = await bootAndReadError(
      createPluginFixture({ id: "p".repeat(65), definitions: [buildHarnessDefinition("pi")] })
        .plugin,
    );

    expect(message).toContain("65 characters long");
    expect(message).toContain("Harness Home");
  });

  it("gives every accepted harness id a path the runner accepts as a Harness Home", async () => {
    const dotted = createPluginFixture({
      id: "my-plugin2",
      definitions: [buildHarnessDefinition("Claude_Code.v2-x")],
    });

    const live = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([dotted.plugin]);
        return yield* host.harnesses();
      }),
    );

    expect(live).toHaveLength(1);
    const home = `providers/homes/account-1/${live[0]!.id}`;
    expect(Schema.is(HarnessHome)(home)).toBe(true);
  });

  it("is errored when its contribution has a key the host does not know", async () => {
    const extra = createPluginFixture({
      id: "extra",
      definitions: [
        {
          ...buildHarnessDefinition("extra"),
          onStart: () => undefined,
        } as HarnessDefinition,
      ],
    });

    const detail = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([extra.plugin]);
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.read("extra"));
      }),
    );

    expect(detail.status._tag).toBe("errored");
    expect(detail.contributions).toEqual([]);
  });
});

/** Boots one plugin and returns its status message when it errored, or `undefined` when it loaded. */
const bootAndReadError = (plugin: Plugin): Promise<string | undefined> =>
  run(
    Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.boot([plugin]);
      const status = Option.getOrNull(yield* host.status(plugin.manifest.id));
      return status?._tag === "errored" ? status.message : undefined;
    }),
  );

describe("what a harness declares it runs", () => {
  const harnessWith = (runs: HarnessDefinition["runs"]) =>
    createPluginFixture({ id: "runner", definitions: [buildHarnessDefinition("runner", runs)] })
      .plugin;

  it("is errored when a provider is not named by its qualified id", async () => {
    const message = await bootAndReadError(harnessWith([{ ...RUNS_ALPHA, providerId: "vendor" }]));

    expect(message).toContain("providerId");
  });

  it("is errored when a provider is listed twice, naming the harness and the provider", async () => {
    const message = await bootAndReadError(harnessWith([RUNS_ALPHA, RUNS_BETA]));

    expect(message).toContain("runner/runner");
    expect(message).toContain("vendor/vendor more than once");
  });

  it("is errored when an account kind of one provider is listed twice", async () => {
    const message = await bootAndReadError(
      harnessWith([{ ...RUNS_ALPHA, kinds: [{ kind: "api-key" }, { kind: "api-key" }] }]),
    );

    expect(message).toContain("the account kind api-key of vendor/vendor");
  });

  it("is errored, naming the field, when the model argument does not hold {model} exactly once", async () => {
    for (const modelArgument of ["vendor/model", "{model}/{model}"]) {
      const message = await bootAndReadError(harnessWith([{ ...RUNS_ALPHA, modelArgument }]));

      expect(message, modelArgument).toContain("runs.0.modelArgument");
    }
  });
});

describe("a plugin that registers a provider", () => {
  const providerPlugin = (
    id: string,
    providers: ReadonlyArray<ProviderDefinition>,
    providerOptions?: ProviderRegistrationOptions,
  ) =>
    createPluginFixture({
      id,
      capabilities: ["providers"],
      definitions: [],
      providers,
      ...(providerOptions === undefined ? {} : { providerOptions }),
    }).plugin;

  it("is listed in registry order under its qualified id, in the catalog and in the host", async () => {
    const vendor = providerPlugin("vendor", [
      buildProviderDefinition("vendor", ["alpha/alpha"]),
      buildProviderDefinition("second"),
    ]);
    const other = providerPlugin("other", [buildProviderDefinition("vendor")]);

    const { details, live } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([vendor, other]);
        return {
          details: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
          live: yield* host.providers(),
        };
      }),
    );

    expect(details.map((detail) => detail.status._tag)).toEqual(["active", "active"]);
    // The catalog lists a plugin's contributions sorted by id; the host keeps registration order.
    expect(details.flatMap((detail) => detail.contributions.map((one) => one.id))).toEqual([
      "vendor/second",
      "vendor/vendor",
      "other/vendor",
    ]);
    expect(details[0]?.contributions[0]?.extensionPoint).toBe("provider");
    expect(live.map((provider) => provider.id)).toEqual([
      "vendor/vendor",
      "vendor/second",
      "other/vendor",
    ]);
    // An account kind keeps the provider's own word, and the harnesses it lists keep their qualified ids.
    expect(live[0]?.kinds.map((kind) => [kind.id, kind.harnesses])).toEqual([
      ["api-key", ["alpha/alpha"]],
    ]);
  });

  it("is registered even while the plugin is disabled, like a harness", async () => {
    const vendor = providerPlugin("vendor", [buildProviderDefinition("vendor")]);

    const live = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([vendor]);
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(sql, sql`UPDATE plugins SET enabled = 0 WHERE id = 'vendor'`);
        yield* host.boot([vendor]);
        return yield* host.providers();
      }),
    );

    expect(live.map((provider) => provider.id)).toEqual(["vendor/vendor"]);
  });

  it("is errored when a harness of an account kind is not named by its qualified id", async () => {
    const message = await bootAndReadError(
      providerPlugin("vendor", [buildProviderDefinition("vendor", ["alpha"])]),
    );

    expect(message).toContain("harnesses");
  });

  it("is errored when an account kind is declared twice", async () => {
    const definition = buildProviderDefinition("vendor");
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        { ...definition, kinds: [definition.kinds[0], definition.kinds[0]] },
      ]),
    );

    expect(message).toContain("vendor/vendor");
    expect(message).toContain("the account kind api-key more than once");
  });

  it("is errored, with no contributions kept, when it registers one id twice", async () => {
    const twice = providerPlugin("twice", [
      buildProviderDefinition("same"),
      buildProviderDefinition("same"),
    ]);

    const { message, live } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([twice]);
        const status = Option.getOrNull(yield* host.status("twice"));
        return {
          message: status?._tag === "errored" ? status.message : undefined,
          live: yield* host.providers(),
        };
      }),
    );

    expect(message).toContain("twice/same");
    expect(live).toEqual([]);
  });

  it("is errored when the qualified id is longer than the catalog allows", async () => {
    // "overlong/" is 9 characters, so a 120 character word makes a 129 character id.
    const message = await bootAndReadError(
      providerPlugin("overlong", [
        { ...buildProviderDefinition("a".repeat(120)), displayName: "Too long" },
      ]),
    );

    expect(message).toContain("the provider id");
    expect(message).toContain("129 characters long, and the limit is 128");
  });

  it("is errored when the definition has a key the host does not know", async () => {
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        {
          ...buildProviderDefinition("vendor"),
          favouriteColour: "blue",
        } as ProviderDefinition,
      ]),
    );

    expect(message).toContain("favouriteColour");
  });

  it("is errored, naming the fields, when a credentials step is not exactly one field named apiKey", async () => {
    const definition = buildProviderDefinition("vendor");
    const withFields = (fields: ReadonlyArray<{ name: string; label: string }>) =>
      providerPlugin("vendor", [
        {
          ...definition,
          kinds: [{ ...definition.kinds[0], setup: [{ kind: "credentials", fields }] }],
        },
      ]);

    for (const fields of [
      [{ name: "token", label: "Token" }],
      [
        { name: "apiKey", label: "API key" },
        { name: "orgId", label: "Organization" },
      ],
    ]) {
      const message = await bootAndReadError(withFields(fields));

      expect(message).toContain(
        `the fields ${fields.map((field) => field.name).join(", ")}; a credentials step must have exactly one field, named apiKey`,
      );
    }
  });

  it("is errored when an account kind declares an oauth, device or pairing step, which the core does not run for accounts", async () => {
    const definition = buildProviderDefinition("vendor");
    for (const step of ["oauth", "device", "pairing"] as const) {
      const message = await bootAndReadError(
        providerPlugin("vendor", [
          {
            ...definition,
            kinds: [
              { ...definition.kinds[0], setup: [...definition.kinds[0].setup, { kind: step }] },
            ],
          },
        ]),
      );

      expect(message, step).toContain("the account kind api-key of the provider vendor/vendor");
      expect(message, step).toContain(`declares the setup step ${step}`);
    }
  });

  it("is errored when a key kind declares no key check, because a key that cannot be checked is never stored", async () => {
    const definition = buildProviderDefinition("vendor");
    const { id, title, description, setup, harnesses } = definition.kinds[0];
    const withoutKeyCheck = { id, title, description, setup, harnesses };
    const message = await bootAndReadError(
      providerPlugin("vendor", [{ ...definition, kinds: [withoutKeyCheck] }]),
    );

    expect(message).toContain("the account kind api-key of the provider vendor/vendor");
    expect(message).toContain("declares no keyCheck");
  });

  it("is errored when a key check is not a fixed https URL", async () => {
    const definition = buildProviderDefinition("vendor");
    for (const url of [
      "http://api.example.com/v1/models",
      "ftp://api.example.com/v1/models",
      "api.example.com/v1/models",
      "https://api.example.com/{apiKey}/models",
      "https://{apiKey}.example.com/models",
    ]) {
      const message = await bootAndReadError(
        providerPlugin("vendor", [
          {
            ...definition,
            kinds: [{ ...definition.kinds[0], keyCheck: { url, headers: {} } }],
          },
        ]),
      );

      expect(message, url).toContain(`its keyCheck url ${url} is not a fixed https:// URL`);
    }
  });

  it("is errored when a key check header holds a placeholder other than {apiKey}", async () => {
    const definition = buildProviderDefinition("vendor");
    for (const value of ["{token}", "Bearer {apiKey} {orgId}", "{{apiKey}}", "Bearer {apiKey"]) {
      const message = await bootAndReadError(
        providerPlugin("vendor", [
          {
            ...definition,
            kinds: [
              {
                ...definition.kinds[0],
                keyCheck: {
                  url: "https://api.example.com/v1/models",
                  headers: { authorization: value },
                },
              },
            ],
          },
        ]),
      );

      expect(message, value).toContain("its keyCheck header authorization holds a placeholder");
    }
  });

  it("is errored when a key check sends no key, because a public endpoint would accept every key", async () => {
    const definition = buildProviderDefinition("vendor");
    for (const headers of [{}, { accept: "application/json" }]) {
      const message = await bootAndReadError(
        providerPlugin("vendor", [
          {
            ...definition,
            kinds: [
              {
                ...definition.kinds[0],
                keyCheck: { url: "https://api.example.com/v1/models", headers },
              },
            ],
          },
        ]),
      );

      expect(message).toContain("the account kind api-key of the provider vendor/vendor");
      expect(message).toContain("its keyCheck sends no key");
      expect(message).toContain("{apiKey}");
    }
  });

  it("is errored when a usage read through a harness names a harness the kind does not run in", async () => {
    const definition = buildProviderDefinition("vendor");
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        {
          ...definition,
          kinds: [
            {
              ...definition.kinds[0],
              usage: { readBy: "harness", harnessId: "beta/beta" },
            },
          ],
        },
      ]),
    );

    expect(message).toContain("the account kind api-key of the provider vendor/vendor");
    expect(message).toContain("its usage is read through the harness beta/beta");
  });

  it("is errored when a usage read from an endpoint has no key to send or breaks the key request rules", async () => {
    const definition = buildProviderDefinition("vendor");
    const endpoint = {
      readBy: "endpoint",
      url: "https://api.example.com/v1/usage",
      headers: { authorization: "{apiKey}" },
    } as const;
    const withUsage = (kind: Record<string, unknown>) =>
      providerPlugin("vendor", [{ ...definition, kinds: [{ ...definition.kinds[0], ...kind }] }]);
    const { id, title, description, harnesses } = definition.kinds[0];
    const tokenKind = {
      id,
      title,
      description,
      harnesses,
      setup: [{ kind: "harness-login", method: "create-token" }],
    } as const;

    expect(
      await bootAndReadError(
        providerPlugin("vendor", [{ ...definition, kinds: [{ ...tokenKind, usage: endpoint }] }]),
      ),
    ).toContain("the kind has no credentials step");
    expect(
      await bootAndReadError(
        withUsage({ usage: { ...endpoint, url: "http://api.example.com/u" } }),
      ),
    ).toContain("its usage url http://api.example.com/u is not a fixed https:// URL");
    expect(await bootAndReadError(withUsage({ usage: { ...endpoint, headers: {} } }))).toContain(
      "its usage sends no key",
    );
  });

  describe("the parser of a usage endpoint", () => {
    const endpointKind = (
      definition: ProviderDefinition,
      usage: NonNullable<AccountKind["usage"]>,
    ): ProviderDefinition => ({
      ...definition,
      kinds: [{ ...definition.kinds[0], usage }],
    });
    const endpoint = {
      readBy: "endpoint",
      url: "https://api.example.com/v1/usage",
      headers: { authorization: "{apiKey}" },
    } as const;
    const parseQuota: ParseUsageBody = () => ({ readings: [] });

    it("is errored when a kind reads its usage from an endpoint and registers no parser for it", async () => {
      const definition = endpointKind(buildProviderDefinition("vendor"), endpoint);

      const message = await bootAndReadError(providerPlugin("vendor", [definition]));

      expect(message).toContain("the account kind api-key of the provider vendor/vendor");
      expect(message).toContain("registers no parseUsageBody for it");
    });

    it("is errored when a parser is registered for a kind that does not read its usage from an endpoint", async () => {
      const definition = buildProviderDefinition("vendor");
      for (const kindId of ["api-key", "no-such-kind"]) {
        const message = await bootAndReadError(
          providerPlugin("vendor", [definition], { parseUsageBody: { [kindId]: parseQuota } }),
        );

        expect(message, kindId).toContain(`registers a parseUsageBody for ${kindId}`);
      }
    });
  });

  it("is errored when an account kind declares two credential sources", async () => {
    const definition = buildProviderDefinition("vendor");
    const credentials = {
      kind: "credentials",
      fields: [{ name: "apiKey", label: "API key" }],
    } as const;
    const cases = [
      {
        setup: [credentials, { kind: "harness-login", method: "create-token" }],
        expected: "both a credentials step and a harness-login step with the method create-token",
      },
      { setup: [credentials, credentials], expected: "more than one credentials step" },
      {
        setup: [
          { kind: "harness-login", method: "create-token" },
          { kind: "harness-login", method: "sign-in" },
        ],
        expected: "more than one harness-login step",
      },
    ] as const;

    for (const { setup, expected } of cases) {
      const message = await bootAndReadError(
        providerPlugin("vendor", [
          { ...definition, kinds: [{ ...definition.kinds[0], setup: [...setup] }] },
        ]),
      );

      expect(message, expected).toContain("the account kind api-key of the provider vendor/vendor");
      expect(message, expected).toContain(expected);
    }
  });

  it("accepts a key kind that has a checklist beside its credentials step", async () => {
    const definition = buildProviderDefinition("vendor");
    const live = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          providerPlugin("vendor", [
            {
              ...definition,
              kinds: [
                {
                  ...definition.kinds[0],
                  setup: [
                    { kind: "checklist", markdown: "Get a key." },
                    ...definition.kinds[0].setup,
                  ],
                },
              ],
            },
          ]),
        ]);
        return yield* host.providers();
      }),
    );

    expect(live.map((provider) => provider.id)).toEqual(["vendor/vendor"]);
  });

  it("accepts a key check that sends the key in several headers", async () => {
    const definition = buildProviderDefinition("vendor");
    const live = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          providerPlugin("vendor", [
            {
              ...definition,
              kinds: [
                {
                  ...definition.kinds[0],
                  keyCheck: {
                    url: "https://api.example.com/v1/models",
                    headers: { "x-api-key": "{apiKey}", authorization: "Bearer {apiKey}" },
                  },
                },
              ],
            },
          ]),
        ]);
        return yield* host.providers();
      }),
    );

    expect(live.map((provider) => provider.id)).toEqual(["vendor/vendor"]);
  });

  it("is errored when its default harness is listed by none of its account kinds", async () => {
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        { ...buildProviderDefinition("vendor"), defaultHarnessId: "beta/beta" },
      ]),
    );

    expect(message).toContain("the provider vendor/vendor has the default harness beta/beta");
  });

  it("is errored when an account kind does not list its default harness, though another kind does", async () => {
    const definition = buildProviderDefinition("vendor", ["alpha/alpha"]);
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        {
          ...definition,
          kinds: [
            definition.kinds[0],
            { ...definition.kinds[0], id: "other-key", harnesses: ["beta/beta"] },
          ],
        },
      ]),
    );

    expect(message).toContain("the provider vendor/vendor has the default harness alpha/alpha");
    expect(message).toContain("other-key");
  });

  it("is errored when an account kind does not list the harness its catalog is read from", async () => {
    const definition = buildProviderDefinition("vendor", ["alpha/alpha"]);
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        { ...definition, catalogSource: { kind: "harness-probe", harnessId: "beta/beta" } },
      ]),
    );

    expect(message).toContain("reads its Model Catalog from the harness beta/beta");
    expect(message).toContain("api-key");
  });

  it("is errored when an account kind has a setup step the core cannot draw", async () => {
    const definition = buildProviderDefinition("vendor");
    const message = await bootAndReadError(
      providerPlugin("vendor", [
        {
          ...definition,
          kinds: [{ ...definition.kinds[0], setup: [{ kind: "ssh" }] }],
        } as unknown as ProviderDefinition,
      ]),
    );

    expect(message).toContain("setup");
  });
});

describe("a plugin whose register crashes", () => {
  it("is errored when the hook throws before it returns an Effect", async () => {
    const thrower = createPluginFixture({
      id: "thrower",
      register: () => {
        throw new Error("no such directory");
      },
    });
    const other = createPluginFixture({ id: "other" });

    const { status, details } = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([thrower.plugin, other.plugin]);
        return {
          status: yield* host.status("thrower"),
          details: yield* Effect.flatMap(Plugins, (plugins) => plugins.query()),
        };
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toBe("no such directory");
    expect(findDetail(details, "other")?.contributions).toHaveLength(1);
  });

  it("is errored when the Effect it returns dies", async () => {
    const dying = createPluginFixture({
      id: "dying",
      register: () => Effect.die(new Error("the manifest was generated wrong")),
    });

    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([dying.plugin]);
        return yield* host.status("dying");
      }),
    );

    const errored = Option.getOrNull(status) as {
      readonly _tag: string;
      readonly message: string;
    } | null;
    expect(errored?._tag).toBe("errored");
    expect(errored?.message).toBe("the manifest was generated wrong");
  });
});

describe("a registry that lists one plugin id twice", () => {
  it("fails the boot, naming the id, because the two would share every namespace", async () => {
    const first = createPluginFixture({ id: "doubled" });
    const second = createPluginFixture({ id: "doubled" });

    const crash = await run(
      Effect.flatMap(PluginHost, (host) => host.boot([first.plugin, second.plugin])).pipe(
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("doubled");
  });
});

describe("a registry plugin whose manifest does not decode", () => {
  it("fails the boot with the decode error, because the registry is compiled into this binary", async () => {
    const wrong = createPluginFixture({ id: "fine" });
    const broken: Plugin = {
      ...wrong.plugin,
      manifest: { ...wrong.plugin.manifest, id: "Not A Slug" },
    };

    const crash = await run(
      Effect.flatMap(PluginHost, (host) => host.boot([broken])).pipe(
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("id");
    expect(crash).toContain("Not A Slug");
  });
});

describe("Plugins.read on an unknown plugin id", () => {
  it("fails with not_found", async () => {
    const only = createPluginFixture({ id: "only" });

    const error = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([only.plugin]);
        return yield* Effect.flip(Effect.flatMap(Plugins, (plugins) => plugins.read("absent")));
      }),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
    expect(JSON.stringify(error)).toContain("absent");
  });
});

/**
 * A config field marked `choices` loads its values from the external account
 * through the connection type's `listChoices`. Registration refuses a mark
 * with no loader behind it, and a mark anywhere a Connection's form is not
 * the place the choices are shown.
 */
describe("a config field that loads its choices from the account", () => {
  const TEAM_FIELD = Schema.Struct({
    team: Schema.optionalKey(Schema.String.annotate({ title: "Team", choices: true })),
  });

  /** Boots a plugin with one connection type, and returns the plugin's status and contributions. */
  const bootConnectionType = (
    parts: Record<string, unknown>,
    manifestConfigSchema: Schema.Top = Schema.Struct({}),
  ) => {
    const plugin: Plugin = {
      manifest: {
        id: "teams",
        displayName: "Plugin teams",
        hostApi: HOST_API,
        capabilities: ["connections"],
        configSchema: manifestConfigSchema,
      },
      register: (host) =>
        registerConnectionType(host, {
          type: "desk",
          displayName: "Desk",
          setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
          validate: () => Effect.succeed({ displayName: "Desk", accountId: "desk-1" }),
          ...parts,
        }),
      activate: () => Effect.succeed(Effect.void),
    };
    return run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([plugin]);
        return {
          status: Option.getOrNull(yield* host.status("teams")) as {
            readonly _tag: string;
            readonly message?: string;
            readonly reason?: { readonly message: string };
          } | null,
          detail: yield* Effect.flatMap(Plugins, (plugins) => plugins.read("teams")),
        };
      }),
    );
  };

  it("registers a type that has the loader, and keeps the mark in the catalog", async () => {
    const { status, detail } = await bootConnectionType({
      configSchema: TEAM_FIELD,
      listChoices: () => Effect.succeed([{ value: "t1", label: "Backend" }]),
    });

    expect(status?._tag).toBe("active");
    expect(detail.contributions).toHaveLength(1);
    expect(detail.contributions[0]?.definition).toMatchObject({
      configSchema: { properties: { team: { type: "string", "x-choices": true } } },
    });
  });

  it("marks the plugin errored when a type marks a field but has no loader, naming the type", async () => {
    const { status, detail } = await bootConnectionType({ configSchema: TEAM_FIELD });

    expect(status?._tag).toBe("errored");
    expect(status?.message).toContain("teams/desk");
    expect(status?.message).toContain("listChoices");
    expect(detail.contributions).toEqual([]);
  });

  it("marks the plugin errored when the marked field is not a string or a list of strings", async () => {
    const { status } = await bootConnectionType({
      configSchema: Schema.Struct({ limit: Schema.Finite.annotate({ choices: true }) }),
      listChoices: () => Effect.succeed([]),
    });

    expect(status?._tag).toBe("errored");
    expect(status?.message).toContain("limit");
  });

  it("marks the plugin errored when the marked field is required, naming the field", async () => {
    const { status, detail } = await bootConnectionType({
      configSchema: Schema.Struct({ team: Schema.String.annotate({ choices: true }) }),
      listChoices: () => Effect.succeed([]),
    });

    expect(status?._tag).toBe("errored");
    expect(status?.message).toContain("teams/desk");
    expect(status?.message).toContain('"team"');
    expect(status?.message).toContain("must be optional");
    expect(detail.contributions).toEqual([]);
  });

  it("refuses the plugin when its own config marks a field, and says where one belongs", async () => {
    const { status } = await bootConnectionType({}, TEAM_FIELD);

    expect(status?._tag).toBe("refused");
    expect(status?.reason?.message).toContain("connection type only");
  });
});

/**
 * An `oauth` or `device` step is a flow the setup screen offers, and its
 * declaration is where that flow sends the user and asks for tokens. One
 * without the other cannot work, so registration refuses the type and names
 * what is missing.
 */
describe("a connection type's token flows", () => {
  const OAUTH = {
    authorizationUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    scopes: [],
  };
  const PUBLIC_REDIRECT_URI = "http://127.0.0.1:4937/oauth/callback";
  const DEVICE = {
    clientId: "client",
    deviceCodeUrl: "https://example.test/device/code",
    tokenUrl: "https://example.test/token",
    scopes: [],
  };

  /** Boots a plugin that registers one connection type with the given flow parts. */
  const bootWithType = (parts: Record<string, unknown>) => {
    const plugin: Plugin = {
      manifest: {
        id: "flows",
        displayName: "Plugin flows",
        hostApi: HOST_API,
        capabilities: ["connections"],
        configSchema: Schema.Struct({}),
      },
      register: (host) =>
        registerConnectionType(host, {
          type: "forge",
          displayName: "Forge",
          setup: [],
          validate: () => Effect.succeed({ displayName: "Forge", accountId: "forge-1" }),
          ...parts,
        }),
      activate: () => Effect.succeed(Effect.void),
    };
    return run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([plugin]);
        return yield* host.status("flows");
      }),
    );
  };

  it.each([
    [
      "an oauth step without its declaration",
      { setup: [{ kind: "oauth" }] },
      "the oauth step needs the oauth declaration",
    ],
    [
      "a device step without its declaration",
      { setup: [{ kind: "device" }] },
      "the device step needs the device declaration",
    ],
    [
      "a device declaration without its step",
      {
        setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Token" }] }],
        device: DEVICE,
      },
      "the device declaration needs a device step",
    ],
    [
      "both a redirect flow and a device flow",
      { setup: [{ kind: "oauth" }, { kind: "device" }], oauth: OAUTH, device: DEVICE },
      "not both",
    ],
    [
      "a public client with an empty client id",
      {
        setup: [{ kind: "oauth" }],
        oauth: { ...OAUTH, publicClient: { clientId: "", redirectUris: [PUBLIC_REDIRECT_URI] } },
      },
      "the public client's clientId is empty",
    ],
    [
      "a public client with no redirect URIs",
      {
        setup: [{ kind: "oauth" }],
        oauth: { ...OAUTH, publicClient: { clientId: "public", redirectUris: [] } },
      },
      "the public client has no redirectUris",
    ],
    ...[
      // Not a URL.
      "/oauth/callback",
      // Neither http nor https.
      "ftp://127.0.0.1:4937/oauth/callback",
      // A host that is not this machine.
      "https://hercule.example/oauth/callback",
      "http://192.168.1.20:4937/oauth/callback",
      // A path other than the callback path.
      "http://127.0.0.1:4937/callback",
      "http://127.0.0.1:4937/base/oauth/callback",
      // A query or a fragment after the callback path.
      "http://127.0.0.1:4937/?next=/oauth/callback",
      "http://127.0.0.1:4937/oauth/callback?next=1",
      "http://127.0.0.1:4937/oauth/callback#top",
    ].map((uri): [string, Record<string, unknown>, string] => [
      `a public client with the redirect URI ${uri}`,
      {
        setup: [{ kind: "oauth" }],
        oauth: {
          ...OAUTH,
          publicClient: { clientId: "public", redirectUris: [PUBLIC_REDIRECT_URI, uri] },
        },
      },
      `the public client's redirect URI ${uri} is not an http or https URL on localhost, 127.0.0.1 or [::1] whose path is exactly /oauth/callback`,
    ]),
    [
      "a pasted credential field named like the core's token set",
      { setup: [{ kind: "credentials", fields: [{ name: "oauth.tokens", label: "Tokens" }] }] },
      "the credential field name oauth.tokens is reserved",
    ],
  ])("refuses %s, naming the type", async (_, parts, reason) => {
    const message = readErroredMessage(await bootWithType(parts));

    expect(message).toContain("flows/forge");
    expect(message).toContain(reason);
  });

  it("accepts a public client on each loopback host, with a redirect flow beside a pasted key", async () => {
    const status = await bootWithType({
      setup: [
        { kind: "oauth" },
        { kind: "credentials", fields: [{ name: "apiKey", label: "Personal API key" }] },
      ],
      oauth: {
        ...OAUTH,
        publicClient: {
          clientId: "public",
          redirectUris: [
            PUBLIC_REDIRECT_URI,
            "http://localhost:4937/oauth/callback",
            "https://[::1]:4937/oauth/callback",
          ],
        },
      },
    });

    expect(readErroredMessage(status)).toBeUndefined();
  });

  it("accepts a device flow beside a pasted token", async () => {
    const status = await bootWithType({
      setup: [
        { kind: "device" },
        { kind: "credentials", fields: [{ name: "pat", label: "Token" }] },
      ],
      device: DEVICE,
    });

    expect(readErroredMessage(status)).toBeUndefined();
  });
});

/** Returns the message of an errored plugin, or `undefined` if the plugin is not errored. */
const readErroredMessage = (status: Option.Option<unknown>): string | undefined => {
  const found = Option.getOrNull(status) as { readonly _tag: string; readonly message?: string };
  return found._tag === "errored" ? found.message : undefined;
};

describe("the workflow action catalog", () => {
  it("has a row for each built-in action, owned by core, and one for each plugin action under its qualified id", async () => {
    const rows = await run(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([notesPlugin]));
        const contributions = yield* Effect.flatMap(pluginRepository, (repository) =>
          repository.contributions(),
        );
        return [...contributions].flatMap(([owner, owned]) =>
          owned
            .filter((row) => row.extensionPoint === "workflow-action")
            .map((row) => `${owner} ${row.id}`),
        );
      }),
    );

    expect(rows.sort()).toEqual([
      "core git.commit",
      "core git.push",
      "core notification.create",
      "core run.start",
      "core task.create",
      "core task.query",
      "core task.update",
      "core wait",
      "notes notes/note.append",
    ]);
  });

  it("marks a plugin errored if its action id contains a / or its input schema is not a struct", async () => {
    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildActionPlugin("slashed", { ...NOTE_APPEND_ACTION, id: "note/append" }),
          buildActionPlugin("listed", {
            ...NOTE_APPEND_ACTION,
            input: Schema.Array(Schema.String),
          }),
        ]);
        return {
          slashed: yield* host.status("slashed"),
          listed: yield* host.status("listed"),
          actions: yield* host.listActiveWorkflowActions(),
        };
      }),
    );

    expect(readErroredMessage(statuses.slashed)).toContain("The id cannot contain a / character");
    expect(readErroredMessage(statuses.listed)).toContain("struct");
    expect(statuses.actions.map((action) => action.id)).toEqual([
      "git.commit",
      "git.push",
      "notification.create",
      "run.start",
      "task.create",
      "task.query",
      "task.update",
      "wait",
    ]);
  });

  it("lists the actions of active plugins only, and finds the action of a stopped or failed plugin by id", async () => {
    const found = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          notesPlugin,
          {
            ...buildActionPlugin("broken", NOTE_APPEND_ACTION),
            activate: () => Effect.fail(new PluginError({ message: "broken on purpose" })),
          },
          buildActionPlugin("slashed", { ...NOTE_APPEND_ACTION, id: "note/append" }),
        ]);
        yield* host.stop("notes");
        const listed = (yield* host.listActiveWorkflowActions()).map((action) => action.id);
        const lookups = yield* Effect.forEach(
          ["notes/note.append", "broken/note.append", "slashed/note/append", "absent/note.append"],
          (id) =>
            Effect.map(
              host.findWorkflowAction(id),
              Option.map((action) => action.owner),
            ),
        );
        return { listed, lookups, broken: yield* host.status("broken") };
      }),
    );

    expect(readErroredMessage(found.broken)).toContain("broken on purpose");
    expect(found.listed.filter((id) => id.includes("/"))).toEqual([]);
    expect(found.lookups).toEqual([
      Option.some("notes"),
      Option.some("broken"),
      Option.none(),
      Option.none(),
    ]);
  });

  it("marks a plugin errored if an action that acts through a Connection has a connection field, or declares another plugin's Connection type", async () => {
    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildActionPlugin("shadowed", {
            ...NOTE_APPEND_ACTION,
            connection: { type: "shadowed/shadowed" },
            input: Schema.Struct({ text: Schema.String, connection: Schema.String }),
          }),
          buildActionPlugin("borrowed", {
            ...NOTE_APPEND_ACTION,
            connection: { type: "github/github" },
          }),
          buildActionPlugin("owned", {
            ...NOTE_APPEND_ACTION,
            connection: { type: "owned/owned" },
          }),
        ]);
        return {
          shadowed: yield* host.status("shadowed"),
          borrowed: yield* host.status("borrowed"),
          owned: yield* host.status("owned"),
        };
      }),
    );

    expect(readErroredMessage(statuses.shadowed)).toContain(
      "its input schema has a field named connection, and that name is reserved",
    );
    expect(readErroredMessage(statuses.borrowed)).toContain(
      "a Connection of type github/github, which the plugin borrowed does not declare",
    );
    expect(readErroredMessage(statuses.owned)).toBeUndefined();
  });

  it("marks a plugin errored if an action lists notification.answer", async () => {
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          // A cast gets past TypeScript, which refuses the place.
          buildActionPlugin("noticed", {
            ...NOTE_APPEND_ACTION,
            usableIn: ["notification.answer"],
            describe: () => [{ kind: "text", text: "Append a note" }],
          } as unknown as WorkflowActionContribution),
        ]);
        return yield* host.status("noticed");
      }),
    );

    expect(readErroredMessage(status)).toContain(
      "it lists notification.answer in usableIn. A plugin action cannot answer a decision Notification",
    );
  });

  it("marks a plugin errored if an action the user's answer may run has no describe, and keeps one that has it", async () => {
    const found = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          // A cast gets past TypeScript, which refuses an answer place
          // without describe, as a plugin built without types could.
          buildActionPlugin("silent", {
            ...NOTE_APPEND_ACTION,
            usableIn: ["workflow.step", "signal.answer"],
          } as unknown as WorkflowActionContribution),
          buildActionPlugin("described", {
            ...NOTE_APPEND_ACTION,
            usableIn: ["signal.answer"],
            describe: () => [{ kind: "text", text: "Append a note" }],
          }),
        ]);
        return {
          silent: yield* host.status("silent"),
          described: yield* host.status("described"),
          action: yield* host.findWorkflowAction("described/note.append"),
        };
      }),
    );

    expect(readErroredMessage(found.silent)).toContain(
      "it lists signal.answer in usableIn but has no describe function",
    );
    expect(readErroredMessage(found.described)).toBeUndefined();
    expect(Option.getOrThrow(found.action).usableIn).toEqual(["signal.answer"]);
  });
});

/**
 * Builds a plugin that declares one event source, with the id `word`, and one
 * event kind. The source polls nothing unless `options.feeds` declares feeds,
 * the manifest requests `event-sources` and `events` unless
 * `options.capabilities` replaces them, and the source is for the type
 * `<id>/<id>` unless `options.connectionType` names another.
 */
const buildEventSourcePlugin = (
  id: string,
  word: string,
  kind: string,
  options: {
    readonly feeds?: Record<string, FeedDeclaration>;
    readonly capabilities?: ReadonlyArray<PluginCapability>;
    readonly connectionType?: string;
  } = {},
): Plugin => ({
  manifest: {
    id,
    displayName: `Plugin ${id}`,
    hostApi: HOST_API,
    capabilities: options.capabilities ?? ["event-sources", "events"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerEventSource(host, {
      id: word,
      connectionType: options.connectionType ?? `${id}/${id}`,
      feeds: options.feeds ?? IDLE_FEEDS,
      open: IDLE_INGEST_OPEN,
      kinds: {
        [kind]: {
          description: `Something happened: ${kind}`,
          schema: Schema.Struct({ url: Schema.String }),
          availableToTriage: true,
        },
      },
    }),
  activate: () => Effect.succeed(Effect.void),
});

describe("the event source catalog", () => {
  it("stores the source's Connection type, kinds and feeds, with each feed's intervals", async () => {
    const definition = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildEventSourcePlugin("acme", "acme", "acme.thing.done", {
            feeds: {
              notifications: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
              repos: { defaultIntervalSeconds: 300 },
            },
          }),
        ]);
        const catalog = yield* Effect.flatMap(pluginRepository, (repository) =>
          repository.contributions(),
        );
        return catalog.get("acme")?.find((row) => row.extensionPoint === "event-source")
          ?.definition;
      }),
    );

    expect(definition).toMatchObject({
      connectionType: "acme/acme",
      kinds: { "acme.thing.done": { description: "Something happened: acme.thing.done" } },
      feeds: {
        notifications: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
        repos: { defaultIntervalSeconds: 300 },
      },
    });
  });

  it("lists the sources of active plugins only", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildEventSourcePlugin("acme", "acme", "acme.thing.done"),
          buildEventSourcePlugin("bolt", "bolt", "bolt.thing.done"),
        ]);
        yield* host.stop("bolt");
        return yield* host.listActiveEventSources();
      }),
    );

    expect(listed.map((source) => [source.id, source.connectionType])).toEqual([
      ["acme/acme", "acme/acme"],
    ]);
  });

  it.each([
    ["a feed name with a /", { "a/b": { defaultIntervalSeconds: 60 } }, 'the feed name "a/b"'],
    ["an empty feed name", { "": { defaultIntervalSeconds: 60 } }, 'the feed name ""'],
    ["a zero interval", { repos: { defaultIntervalSeconds: 0 } }, "the feed repos is invalid"],
    [
      "a minimum longer than the default",
      { repos: { defaultIntervalSeconds: 60, minIntervalSeconds: 120 } },
      "Make the minimum no longer than the default.",
    ],
    ["no feeds at all", {}, "declares no feeds, so the host would never poll it"],
    [
      "a default longer than one day",
      { repos: { defaultIntervalSeconds: 86_401 } },
      "the feed repos has a default interval of 86401 seconds",
    ],
  ])("marks a plugin errored for %s", async (_, feeds, expected) => {
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([buildEventSourcePlugin("acme", "acme", "acme.thing.done", { feeds })]);
        return yield* host.status("acme");
      }),
    );

    expect(readErroredMessage(status)).toContain(expected);
  });

  it("marks a plugin errored if its manifest lacks the events capability, and says to add it", async () => {
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildEventSourcePlugin("acme", "acme", "acme.thing.done", {
            capabilities: ["event-sources"],
          }),
        ]);
        return yield* host.status("acme");
      }),
    );

    expect(readErroredMessage(status)).toContain(`Add "events" to the manifest's capabilities.`);
  });

  it("marks a plugin errored if its event source id contains a /", async () => {
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([buildEventSourcePlugin("acme", "acme/feed", "acme.thing.done")]);
        return yield* host.status("acme");
      }),
    );

    expect(readErroredMessage(status)).toContain("The id cannot contain a / character");
  });

  it("marks a plugin errored if its event source is for another plugin's Connection type", async () => {
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildEventSourcePlugin("acme", "acme", "acme.thing.done", {
            connectionType: "bolt/bolt",
          }),
        ]);
        return yield* host.status("acme");
      }),
    );

    expect(readErroredMessage(status)).toContain(
      "the event source acme is for the Connection type bolt/bolt, which another plugin owns",
    );
  });

  it("marks a plugin errored if two of its event sources are for one Connection type", async () => {
    const twoSources: Plugin = {
      ...buildEventSourcePlugin("acme", "acme", "acme.thing.done"),
      register: (host) =>
        Effect.forEach(
          ["first", "second"],
          (word) =>
            registerEventSource(host, {
              id: word,
              connectionType: "acme/acme",
              feeds: IDLE_FEEDS,
              open: IDLE_INGEST_OPEN,
              kinds: {
                [`acme.${word}.done`]: {
                  description: `Something happened: ${word}`,
                  schema: Schema.Struct({ url: Schema.String }),
                  availableToTriage: true,
                },
              },
            }),
          { discard: true },
        ),
    };
    const status = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([twoSources]);
        return yield* host.status("acme");
      }),
    );

    expect(readErroredMessage(status)).toContain(
      "the event sources acme/first and acme/second are both for the Connection type acme/acme",
    );
  });

  it("marks a plugin errored if it declares a core event kind, and includes the kind in the message", async () => {
    const statuses = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildEventSourcePlugin("task", "task", "task.created"),
          buildEventSourcePlugin("cron", "cron", "cron.tick"),
        ]);
        return [yield* host.status("task"), yield* host.status("cron")];
      }),
    );

    for (const [status, kind] of [
      [statuses[0]!, "task.created"],
      [statuses[1]!, "cron.tick"],
    ] as const) {
      const message = readErroredMessage(status);
      expect(message, kind).toContain(`the event kind ${kind} is already declared by the core`);
    }
  });
});

describe("a registry that lists a plugin with the id core", () => {
  it("fails the boot, because that id is reserved for the built-in contributions", async () => {
    const crash = await run(
      Effect.flatMap(PluginHost, (host) =>
        host.boot([createPluginFixture({ id: "core" }).plugin]),
      ).pipe(
        Effect.as("booted"),
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      ),
    );

    expect(crash).toContain("a plugin with the id core");
    expect(crash).toContain("Give the plugin another id.");
  });
});
