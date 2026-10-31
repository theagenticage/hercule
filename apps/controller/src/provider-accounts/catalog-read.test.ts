/**
 * Tests `readCatalogWithKey` through the Provider Account service, on a real
 * database and with the provider's API replaced at the `HttpClient` seam: what
 * is stored for each answer, and which answers fail the account.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Logger } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { ProviderAccountProbes } from "./probes";
import { ProviderKeyRequestTimeout } from "./provider-key-requests";
import { ProviderAccountService } from "./service";
import {
  ACME_PROVIDER_ID,
  addAccount,
  buildAccountPlugins,
  buildCataloguedPlugin,
  buildFakeProviderApi,
  CATALOGUED_CATALOG_URL,
  CATALOGUED_KEY_KIND,
  CATALOGUED_PROVIDER_ID,
  runWithAccounts,
  storeCredential,
  type FakeProviderAnswer,
} from "./testing";

const PLUGINS = [...buildAccountPlugins(), buildCataloguedPlugin()];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** A 401 with the words a provider gives for refusing a key. */
const refusal = (message: string): Response => json({ error: { message } }, 401);

/** Builds the body Catalogued answers with, for models named `m1`, `m2` and so on. */
const catalogOf = (count: number, from = 1): Response =>
  json({
    models: Array.from({ length: count }, (_, index) => ({
      id: `m${from + index}`,
      name: `Model ${from + index}`,
    })),
  });

const withService = <A, E, R>(
  body: (service: ProviderAccountService["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ProviderAccountService, body);

/** Adds a Catalogued account holding the key `sk-live`. */
const addCataloguedAccount = Effect.gen(function* () {
  const account = yield* addAccount({
    providerId: CATALOGUED_PROVIDER_ID,
    kind: CATALOGUED_KEY_KIND,
    label: "Work",
  });
  yield* storeCredential(account.id, "apiKey", "sk-live");
  return account;
});

/** Reads the catalog of the account once, as the controller daemon does: with a stamp taken first. */
const readFromApi = (accountId: string) =>
  Effect.gen(function* () {
    const probes = yield* ProviderAccountProbes;
    const stamp = yield* probes.readProbeStamp(accountId, false);
    yield* withService((service) => service.readCatalogWithKey(accountId, stamp));
  });

/**
 * Reads the catalog of a new Catalogued account once for each of `answers`,
 * the provider giving the next answer to each request, and returns the
 * account and its catalog as the user sees them after each read, the requests
 * sent, and the log lines.
 */
const readInSequence = async (
  answers: ReadonlyArray<() => FakeProviderAnswer>,
  options: { readonly timeout?: Duration.Duration; readonly key?: string } = {},
) => {
  let next = 0;
  const api = buildFakeProviderApi(() => answers[next++]!());
  const logged: Array<string> = [];
  const steps = await runWithAccounts(
    Effect.gen(function* () {
      const added = yield* addCataloguedAccount;
      if (options.key !== undefined) yield* storeCredential(added.id, "apiKey", options.key);
      const afterEach = [];
      for (let read = 0; read < answers.length; read++) {
        yield* readFromApi(added.id);
        afterEach.push({
          account: yield* withService((service) => service.read(added.id)),
          catalog: yield* withService((service) => service.readCatalog(added.id)),
        });
      }
      return afterEach;
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>(({ message }) => {
            logged.push(String(message));
          }),
        ]),
      ),
      options.timeout === undefined
        ? (effect) => effect
        : Effect.provideService(ProviderKeyRequestTimeout, options.timeout),
    ),
    api.client,
    PLUGINS,
  );
  return { steps, requests: api.requests, logged };
};

/**
 * Reads the catalog once, after a good read of models `m1` and `m2`, with the
 * provider answering `answer`, and returns the state after the second read.
 */
const readAfterGoodRead = async (
  answer: () => FakeProviderAnswer,
  options: { readonly timeout?: Duration.Duration } = {},
) => {
  const { steps, requests, logged } = await readInSequence([() => catalogOf(2), answer], options);
  return { good: steps[0]!, ...steps[1]!, requests, logged };
};

const slugsOf = (catalog: { readonly models: ReadonlyArray<{ readonly slug: string }> }) =>
  catalog.models.map((model) => model.slug);

describe("ProviderAccountService.readCatalogWithKey", () => {
  it("stores the models with their details and sends the key without following a redirect", async () => {
    const { steps, requests } = await readInSequence([
      () =>
        json({
          models: [{ id: "big", name: "Big", context: 200000, price: 3 }, { name: "no id" }],
        }),
    ]);

    const { catalog } = steps[0]!;
    expect(catalog.models).toMatchObject([
      { slug: "big", name: "Big", contextWindow: 200000, inputPrice: 3 },
    ]);
    expect(catalog.readAt).not.toBeNull();
    expect(catalog.error).toBeNull();
    expect(requests).toEqual([
      {
        url: CATALOGUED_CATALOG_URL,
        headers: { authorization: "Bearer sk-live" },
        redirect: "manual",
      },
    ]);
  });

  it("replaces the models of an earlier read", async () => {
    const { catalog } = await readAfterGoodRead(() => catalogOf(1, 7));

    expect(slugsOf(catalog)).toEqual(["m7"]);
  });

  it("keeps up to 1,024 models", async () => {
    const { steps } = await readInSequence([() => catalogOf(1024)]);

    expect(steps[0]!.catalog.models).toHaveLength(1024);
    expect(steps[0]!.catalog.error).toBeNull();
  });

  it("fails the read and the account with the provider's words on a 401, keeping the models", async () => {
    const { good, account, catalog } = await readAfterGoodRead(() => refusal("Key revoked"));

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.readAt).toBe(good.catalog.readAt);
    expect(catalog.error).toBe("Key revoked");
    expect(account.failure).toMatchObject({ message: "Key revoked" });
  });

  it("does not mark a refused key accepted when a later read lists models", async () => {
    const { steps } = await readInSequence([() => refusal("Key revoked"), () => catalogOf(2)]);

    expect(slugsOf(steps[1]!.catalog)).toEqual(["m1", "m2"]);
    expect(steps[1]!.catalog.error).toBeNull();
    expect(steps[1]!.account.failure).toMatchObject({ message: "Key revoked" });
  });

  it.each([
    ["the provider answers 403", () => json({ error: { message: "nope" } }, 403), "HTTP 403"],
    ["the provider answers 429", () => json({}, 429), "HTTP 429"],
    ["the provider answers 500", () => new Response("oops", { status: 500 }), "HTTP 500"],
    ["the provider redirects", () => new Response(null, { status: 302 }), "HTTP 302"],
    ["the provider cannot be reached", () => "unreachable" as const, "did not answer in time"],
    ["the answer is not JSON", () => new Response("<html>"), "is not JSON"],
  ])("keeps the models and the account's status when %s", async (_name, answer, expected) => {
    const { good, account, catalog } = await readAfterGoodRead(answer);

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.readAt).toBe(good.catalog.readAt);
    expect(catalog.error).toContain("Catalogued");
    expect(catalog.error).toContain(expected);
    expect(account.failure).toBeNull();
  });

  it("keeps the models when the provider does not answer within the timeout", async () => {
    const { catalog, account } = await readAfterGoodRead(() => "silent", {
      timeout: Duration.millis(20),
    });

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.error).toContain("did not answer in time");
    expect(account.failure).toBeNull();
  });

  it("keeps the models and says so when the answer is over 4 MiB", async () => {
    const { catalog, logged } = await readAfterGoodRead(
      () => new Response(`{"models":[],"padding":"${"x".repeat(5 * 1024 * 1024)}"}`),
    );

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.error).toBe("The list of models Catalogued sent is larger than 4 MiB.");
    expect(logged.join("\n")).not.toContain("xxxxxxxx");
  });

  it("reads an answer between 64 kB and 4 MiB in full", async () => {
    const models = Array.from({ length: 900 }, (_, index) => ({
      id: `m${index}`,
      name: `A model with a long name to make the body larger ${"x".repeat(100)}`,
    }));
    const body = JSON.stringify({ models });
    expect(body.length).toBeGreaterThan(64 * 1024);

    const { steps } = await readInSequence([() => new Response(body)]);

    expect(steps[0]!.catalog.models).toHaveLength(900);
  });

  it("keeps the models, and keeps the parser's message out of what the user sees, when the parser throws", async () => {
    const { catalog, logged } = await readAfterGoodRead(() => json({ surprise: true }));

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.error).toContain("the plugin that reads it failed on it");
    expect(catalog.error).not.toContain("no models list");
    expect(logged.join("\n")).toContain("the body has no models list");
  });

  it("keeps the models when the parser returns a model that is not valid", async () => {
    const { catalog } = await readAfterGoodRead(() =>
      json({ models: [{ id: "bad", name: "Bad", context: 0 }] }),
    );

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.error).toContain("models that are not valid");
  });

  it("keeps the models and says what is too many when the provider lists more than Hercule keeps", async () => {
    const { catalog } = await readAfterGoodRead(() => catalogOf(1100));

    expect(slugsOf(catalog)).toEqual(["m1", "m2"]);
    expect(catalog.error).toBe(
      "Catalogued lists 1,100 models, more than the 1,024 Hercule can keep.",
    );
  });

  it("records a failed read and sends nothing when no key is stored", async () => {
    const api = buildFakeProviderApi();
    const catalog = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({
          providerId: CATALOGUED_PROVIDER_ID,
          kind: CATALOGUED_KEY_KIND,
        });
        yield* readFromApi(account.id);
        return yield* withService((service) => service.readCatalog(account.id));
      }),
      api.client,
      PLUGINS,
    );

    expect(api.requests).toEqual([]);
    expect(catalog.error).toContain("No usable key is stored");
  });

  it("reads nothing with a stored key that a header cannot carry, and says so", async () => {
    const { steps, requests } = await readInSequence([() => catalogOf(1)], { key: "sk bad\nkey" });

    expect(requests).toEqual([]);
    expect(steps[0]!.catalog.error).toContain("a header cannot carry");
  });

  describe("when the key is replaced while the read is in flight", () => {
    /**
     * Reads the catalog of a Catalogued account whose provider answers
     * `answer` only after the key has been replaced. Returns the account and
     * its catalog as the user sees them afterwards.
     */
    const readWhileKeyIsReplaced = (answer: () => Response) => {
      const hook: { replaceKey: Effect.Effect<unknown> | undefined } = { replaceKey: undefined };
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          // Replacing the key checks it with a request of its own, which must not replace it again.
          if (request.url !== CATALOGUED_CATALOG_URL) {
            return HttpClientResponse.fromWeb(request, json({}));
          }
          const replace = hook.replaceKey;
          hook.replaceKey = undefined;
          yield* replace ?? Effect.void;
          return HttpClientResponse.fromWeb(request, answer());
        }),
      );
      return runWithAccounts(
        Effect.gen(function* () {
          const added = yield* addCataloguedAccount;
          const context = yield* Effect.context<
            ProviderAccountService | ProviderAccountProbes | SqlClient.SqlClient
          >();
          hook.replaceKey = withService((service) =>
            service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
          ).pipe(Effect.provideContext(context), Effect.orDie);
          yield* readFromApi(added.id);
          return {
            account: yield* withService((service) => service.read(added.id)),
            catalog: yield* withService((service) => service.readCatalog(added.id)),
          };
        }),
        client,
        PLUGINS,
      );
    };

    it("stores none of the old key's models", async () => {
      const { catalog } = await readWhileKeyIsReplaced(() => catalogOf(2));

      expect(catalog.models).toEqual([]);
      expect(catalog.readAt).toBeNull();
    });

    it("does not fail the new key with the refusal of the old one", async () => {
      const { account, catalog } = await readWhileKeyIsReplaced(() => refusal("Key revoked"));

      expect(account.failure).toBeNull();
      expect(catalog.error).toBeNull();
    });
  });

  it("does nothing for an account that does not exist", async () => {
    const api = buildFakeProviderApi();
    await runWithAccounts(
      withService((service) =>
        service.readCatalogWithKey("0199e0e7-9999-7000-8000-000000000000", {
          sentAt: "2026-10-31T10:00:00.000Z",
          credentialGeneration: 0,
          readUsage: false,
        }),
      ),
      api.client,
      PLUGINS,
    );

    expect(api.requests).toEqual([]);
  });

  it("does nothing for an account whose provider reads its catalog through a harness", async () => {
    const api = buildFakeProviderApi();
    await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ providerId: ACME_PROVIDER_ID });
        yield* storeCredential(account.id, "apiKey");
        yield* readFromApi(account.id);
      }),
      api.client,
      PLUGINS,
    );

    expect(api.requests).toEqual([]);
  });
});
