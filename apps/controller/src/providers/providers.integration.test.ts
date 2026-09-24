/**
 * The registry is fixture plugins, so the listing carries the definitions
 * written here rather than whatever providers the binary compiles in.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Schema } from "effect";
import type { LiveMessage } from "@hercule/contract";
import { secret, type Plugin, type ProviderDefinition } from "@hercule/plugin-host";
import {
  collectMessages,
  completeSetup,
  del,
  expectHeld,
  get,
  onSocket,
  post,
  send,
  waitForLiveToSettle,
  fetchTicket,
  withServer,
  waitWithin,
  type ServerHarness,
} from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";

const ALPHA = buildProviderDefinition("alpha-provider", { token: "alpha-default" });
const BETA = buildProviderDefinition("beta-provider", { token: "beta-default" });

const SINGLE = {
  ...buildProviderDefinition("single-provider", { token: "the-only-one" }),
  supportsMultipleInstances: false,
};

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "alpha", definitions: [ALPHA] }).plugin,
  createPluginFixture({ id: "beta", definitions: [BETA] }).plugin,
];

const withProviders = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
  withServer(body, { plugins: buildPlugins() });

interface ProviderInstance {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly snapshots: ReadonlyArray<unknown>;
  readonly declared?: Record<string, unknown>;
  /** What the provider's plugin marked secret, and whether each one is set. */
  readonly secretFields?: ReadonlyArray<{
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly set: boolean;
  }>;
}

/** An id that is well-formed and belongs to nobody. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const listInstances = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<ProviderInstance>> => {
  const response = await get(base, "/api/v1/providers", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<ProviderInstance>;
};

const filterByProvider = (
  instances: ReadonlyArray<ProviderInstance>,
  providerId: string,
): ReadonlyArray<ProviderInstance> =>
  instances.filter((instance) => instance.providerId === providerId);

const readInstance = async (base: string, token: string, id: string): Promise<ProviderInstance> => {
  const response = await get(base, `/api/v1/providers/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProviderInstance;
};

const createInstance = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/providers", body, token);

const patchInstance = (base: string, token: string, id: string, body: unknown): Promise<Response> =>
  send("PATCH", base, `/api/v1/providers/${id}`, { body, token });

const parseCreatedInstance = async (response: Response): Promise<ProviderInstance> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProviderInstance;
};

interface ApiError {
  readonly error: { readonly code: string; readonly message?: string; readonly details?: unknown };
}

const readApiError = async (response: Response, status: number): Promise<ApiError> => {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as ApiError;
};

const readProviderAudit = (
  sql: ServerHarness["sql"],
): Promise<ReadonlyArray<{ readonly kind: string; readonly actor: string | null }>> =>
  Effect.runPromise(
    Effect.orDie(
      sql<{ readonly kind: string; readonly actor: string | null }>`
        SELECT kind, actor FROM events WHERE kind LIKE 'provider.%' ORDER BY id`,
    ),
  );

const readLastProviderPayload = (sql: ServerHarness["sql"]): Promise<Record<string, unknown>> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.map(
        sql<{ readonly payload: string }>`
          SELECT payload FROM events WHERE kind LIKE 'provider.%' ORDER BY id DESC LIMIT 1`,
        (rows) => JSON.parse(rows[0]!.payload) as Record<string, unknown>,
      ),
    ),
  );

describe("GET /providers after a boot", () => {
  it("gives every registered provider one instance, named after it, with its default config", async () => {
    await withProviders(async ({ base }) => {
      const token = await completeSetup(base);

      const instances = await listInstances(base, token);

      expect(instances.map((instance) => instance.providerId).sort()).toEqual([
        "alpha-provider",
        "beta-provider",
      ]);
      for (const definition of [ALPHA, BETA]) {
        const [instance] = filterByProvider(instances, definition.id);
        expect(instance?.config, definition.id).toEqual(definition.defaultConfig);
        expect(instance?.snapshots, definition.id).toEqual([]);
        expect(instance?.name, definition.id).toBe(definition.displayName);
      }
    });
  });

  it("leaves the instances exactly as they were on a second boot", async () => {
    await withProviders(async ({ base, reboot }) => {
      const token = await completeSetup(base);
      const before = await listInstances(base, token);

      await reboot();

      expect(await listInstances(base, token)).toEqual(before);
    });
  });

  it("gives a provider whose only instance was deleted a fresh one at the next boot", async () => {
    await withProviders(async ({ base, reboot }) => {
      const token = await completeSetup(base);
      const [alpha] = filterByProvider(await listInstances(base, token), "alpha-provider");
      expect(alpha).toBeDefined();

      expect((await del(base, `/api/v1/providers/${alpha!.id}`, token)).status).toBe(200);
      expect((await listInstances(base, token)).map((instance) => instance.providerId)).toEqual([
        "beta-provider",
      ]);

      await reboot();

      const after = await listInstances(base, token);
      expect(after.map((instance) => instance.providerId).sort()).toEqual([
        "alpha-provider",
        "beta-provider",
      ]);
      const replacement = filterByProvider(after, "alpha-provider");
      expect(replacement).toHaveLength(1);
      expect(replacement[0]?.id).not.toBe(alpha!.id);
      expect(replacement[0]?.config).toEqual(ALPHA.defaultConfig);
    });
  });
});

describe("the writes on /providers", () => {
  it("creates an instance, stamped and audited, and reads it back with the definition's declared facts", async () => {
    await withProviders(async ({ base, sql }) => {
      const token = await completeSetup(base);

      const instance = await parseCreatedInstance(
        await createInstance(base, token, {
          providerId: "alpha-provider",
          name: "second account",
          config: { token: "a-second-token" },
        }),
      );

      expect(instance).toMatchObject({
        providerId: "alpha-provider",
        name: "second account",
        config: { token: "a-second-token" },
      });
      expect(await readInstance(base, token, instance.id)).toMatchObject({
        id: instance.id,
        name: "second account",
        config: { token: "a-second-token" },
        declared: ALPHA.declared,
      });
      expect(filterByProvider(await listInstances(base, token), "alpha-provider")).toHaveLength(2);

      // Two rows precede this one: the boot opened an instance per provider.
      expect((await readProviderAudit(sql)).at(-1)).toEqual({
        kind: "provider.created",
        actor: "user",
      });
    });
  });

  it("refuses a config the provider's schema rejects, naming the field, and changes nothing", async () => {
    await withProviders(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const before = await listInstances(base, token);
      const [alpha] = filterByProvider(before, "alpha-provider");

      const rejected = await readApiError(
        await createInstance(base, token, {
          providerId: "alpha-provider",
          name: "no token",
          config: {},
        }),
        400,
      );
      expect(rejected.error.code).toBe("validation");
      expect(JSON.stringify(rejected.error)).toContain("token");

      const patched = await readApiError(
        await patchInstance(base, token, alpha!.id, { config: { token: 42 } }),
        400,
      );
      expect(patched.error.code).toBe("validation");
      expect(JSON.stringify(patched.error)).toContain("token");

      expect(await listInstances(base, token)).toEqual(before);
      expect(await readInstance(base, token, alpha!.id)).toMatchObject({
        config: ALPHA.defaultConfig,
      });
      expect(await readProviderAudit(sql)).toEqual([
        { kind: "provider.created", actor: "system" },
        { kind: "provider.created", actor: "system" },
      ]);
    });
  });

  it("refuses a create for a provider no plugin registered", async () => {
    await withProviders(async ({ base }) => {
      const token = await completeSetup(base);

      const rejected = await readApiError(
        await createInstance(base, token, {
          providerId: "gamma-provider",
          name: "gamma",
          config: { token: "t" },
        }),
        400,
      );

      expect(rejected.error.code).toBe("validation");
      expect(filterByProvider(await listInstances(base, token), "gamma-provider")).toEqual([]);
    });
  });

  it("updates the name and the config", async () => {
    await withProviders(async ({ base }) => {
      const token = await completeSetup(base);
      const [alpha] = filterByProvider(await listInstances(base, token), "alpha-provider");

      const renamed = await patchInstance(base, token, alpha!.id, { name: "work account" });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: alpha!.id, name: "work account" });

      const reconfigured = await patchInstance(base, token, alpha!.id, {
        config: { token: "rotated" },
      });
      expect(reconfigured.status, await reconfigured.clone().text()).toBe(200);
      expect(await readInstance(base, token, alpha!.id)).toMatchObject({
        name: "work account",
        config: { token: "rotated" },
      });
    });
  });

  it("refuses a second account on a provider that holds one", async () => {
    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);

        const refused = await readApiError(
          await createInstance(base, token, {
            providerId: "single-provider",
            name: "second account",
            config: { token: "another" },
          }),
          400,
        );

        expect(refused.error.code).toBe("validation");
        expect(filterByProvider(await listInstances(base, token), "single-provider")).toHaveLength(
          1,
        );
      },
      { plugins: [createPluginFixture({ id: "single", definitions: [SINGLE] }).plugin] },
    );
  });

  it("deletes the instance, and reads not_found afterwards", async () => {
    await withProviders(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const [alpha] = filterByProvider(await listInstances(base, token), "alpha-provider");

      const deleted = await del(base, `/api/v1/providers/${alpha!.id}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      // The log is kept for months, and an instance's config is where a
      // provider's secrets go.
      expect(await readLastProviderPayload(sql)).toEqual({
        instanceId: alpha!.id,
        providerId: "alpha-provider",
        name: alpha!.name,
      });

      expect(filterByProvider(await listInstances(base, token), "alpha-provider")).toEqual([]);
      const gone = await readApiError(
        await get(base, `/api/v1/providers/${alpha!.id}`, token),
        404,
      );
      expect(gone.error.code).toBe("not_found");
      const never = await readApiError(
        await get(base, `/api/v1/providers/${UNKNOWN_ID}`, token),
        404,
      );
      expect(never.error.code).toBe("not_found");
    });
  });
});

describe("what a live subscriber is told about a provider instance", () => {
  it("names the instance once per write, whichever of the three it was", async () => {
    await withProviders(async (harness) => {
      const token = await completeSetup(harness.base);
      // The boot opened an instance per provider, and that announcement is
      // still in flight when the listener comes up.
      await waitForLiveToSettle();
      const ticket = await fetchTicket(harness.base, token);

      let seen: ReadonlyArray<LiveMessage> = [];
      let subject = "";
      await onSocket(harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const providers = yield* collectMessages(client, { topic: "provider" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "provider"));

          // Changes are coalesced over a short window, so two writes back to
          // back would arrive as one message.
          const instance = yield* Effect.promise(() =>
            createInstance(harness.base, token, {
              providerId: "alpha-provider",
              name: "second account",
              config: { token: "a-second-token" },
            }).then(parseCreatedInstance),
          );
          subject = instance.id;
          const writes: ReadonlyArray<() => Promise<Response>> = [
            () => patchInstance(harness.base, token, instance.id, { name: "renamed" }),
            () => del(harness.base, `/api/v1/providers/${instance.id}`, token),
          ];
          expect(
            yield* Effect.promise(() => waitWithin(2000, () => providers.received.length > 0)),
          ).toBe(true);
          for (const [index, write] of writes.entries()) {
            const response = yield* Effect.promise(write);
            expect(response.status, yield* Effect.promise(() => response.text())).toBe(200);
            expect(
              yield* Effect.promise(() =>
                waitWithin(2000, () => providers.received.length > index + 1),
              ),
            ).toBe(true);
          }

          seen = providers.received;
          yield* Fiber.interrupt(providers.fiber);
        }),
      );

      expect(seen).toHaveLength(3);
      expect(seen.map((message) => (message as { ids: ReadonlyArray<string> }).ids)).toEqual([
        [subject],
        [subject],
        [subject],
      ]);
      for (const message of seen) expect(message._tag).toBe("invalidate");
    });
  });
});

/**
 * A secret-valued config field. The value never travels through the instance:
 * it is set through `secret.set` and lives in the secrets table, and an
 * instance only ever says whether one is there. Everything else the UI needs to
 * ask for it - the label, the sentence under it - is the plugin's own words,
 * carried out beside the flag.
 */
describe("what an instance says about its secret-valued fields", () => {
  const KEY_TITLE = "Z.ai API key";
  const KEY_DESCRIPTION = "From your Z.ai Coding Plan subscription.";
  const KEY_VALUE = "a-paid-credential-nobody-else-holds";

  const KEYED: ProviderDefinition = {
    ...buildProviderDefinition("keyed-provider", { token: "keyed-default" }),
    configSchema: Schema.Struct({
      token: Schema.String,
      zaiApiKey: secret({ title: KEY_TITLE, description: KEY_DESCRIPTION }),
    }),
  };

  const withKeyed = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
    withServer(body, {
      plugins: [
        createPluginFixture({ id: "keyed", definitions: [KEYED] }).plugin,
        createPluginFixture({ id: "plain", definitions: [ALPHA] }).plugin,
      ],
    });

  const setKey = (base: string, token: string, id: string, value: string): Promise<Response> =>
    send("PUT", base, `/api/v1/secrets/provider-instance/${id}/zaiApiKey`, {
      body: { value },
      token,
    });

  it("names the field in the plugin's words and says it is not set yet", async () => {
    await withKeyed(async ({ base }) => {
      const token = await completeSetup(base);
      const [keyed] = filterByProvider(await listInstances(base, token), "keyed-provider");

      expect(keyed?.secretFields).toEqual([
        { name: "zaiApiKey", title: KEY_TITLE, description: KEY_DESCRIPTION, set: false },
      ]);
      expect((await readInstance(base, token, keyed!.id)).secretFields).toEqual(
        keyed!.secretFields,
      );
      // A provider that marked nothing secret says so rather than saying nothing.
      expect(
        filterByProvider(await listInstances(base, token), "alpha-provider")[0]?.secretFields,
      ).toEqual([]);
    });
  });

  it("says the key is set once it is, and never hands the value back", async () => {
    await withKeyed(async ({ base }) => {
      const token = await completeSetup(base);
      const [keyed] = filterByProvider(await listInstances(base, token), "keyed-provider");

      const stored = await setKey(base, token, keyed!.id, KEY_VALUE);
      expect(stored.status, await stored.clone().text()).toBe(200);

      const after = await readInstance(base, token, keyed!.id);
      expect(after.secretFields).toEqual([
        { name: "zaiApiKey", title: KEY_TITLE, description: KEY_DESCRIPTION, set: true },
      ]);
      expect(JSON.stringify(after)).not.toContain(KEY_VALUE);
      // Not in the config either: a secret-marked field is never stored there.
      expect(after.config).toEqual(KEYED.defaultConfig);

      const listed = filterByProvider(await listInstances(base, token), "keyed-provider");
      expect(listed[0]?.secretFields).toEqual(after.secretFields);
      expect(JSON.stringify(listed)).not.toContain(KEY_VALUE);
    });
  });

  it("refuses a secret-marked field written into the config, naming it, and stores nothing", async () => {
    await withKeyed(async ({ base }) => {
      const token = await completeSetup(base);
      const [keyed] = filterByProvider(await listInstances(base, token), "keyed-provider");

      const rejected = await readApiError(
        await patchInstance(base, token, keyed!.id, {
          config: { token: "keyed-default", zaiApiKey: KEY_VALUE },
        }),
        400,
      );

      expect(rejected.error.code).toBe("validation");
      expect(JSON.stringify(rejected.error)).toContain("zaiApiKey");
      // The rejection must not be the place the value gets written down.
      expect(JSON.stringify(rejected.error)).not.toContain(KEY_VALUE);

      const after = await readInstance(base, token, keyed!.id);
      expect(after.config).toEqual(KEYED.defaultConfig);
      expect(after.secretFields).toEqual([
        { name: "zaiApiKey", title: KEY_TITLE, description: KEY_DESCRIPTION, set: false },
      ]);
    });
  });
  it("takes the stored credential with it when the instance is deleted", async () => {
    await withKeyed(async ({ base }) => {
      const token = await completeSetup(base);
      const [keyed] = filterByProvider(await listInstances(base, token), "keyed-provider");
      const stored = await setKey(base, token, keyed!.id, KEY_VALUE);
      expect(stored.status, await stored.clone().text()).toBe(200);

      const removed = await del(base, `/api/v1/providers/${keyed!.id}`, token);

      expect(removed.status, await removed.clone().text()).toBe(200);
      // A credential outliving its owner would be inherited by whatever is
      // given that id next.
      const left = await get(
        base,
        `/api/v1/secrets?ownerKind=provider-instance&ownerId=${keyed!.id}`,
        token,
      );
      expect(await left.json()).toEqual({ items: [] });
    });
  });
});
