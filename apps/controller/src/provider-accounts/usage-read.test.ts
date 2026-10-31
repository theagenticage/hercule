/**
 * Tests `readUsageWithKey` through the Provider Account service, on a real
 * database and with the provider's API replaced at the `HttpClient` seam: what
 * is stored for each answer, and which answers fail the account.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import { createPluginFixture } from "../plugins/testing";
import { ProviderAccountService } from "./service";
import { UsageReadTimeout } from "./usage-endpoint";
import {
  addAccount,
  ALPHA_HARNESS_ID,
  buildFakeProviderApi,
  runWithAccounts,
  storeCredential,
  type FakeProviderAnswer,
} from "./testing";

const PROVIDER_ID = "metered/metered";
const USAGE_URL = "https://api.metered.test/v1/usage";

const METERED: ProviderDefinition = {
  id: "metered",
  displayName: "Metered",
  kinds: [
    {
      id: "api-key",
      title: "API key",
      description: "A key for Metered.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      keyCheck: {
        url: "https://api.metered.test/v1/models",
        headers: { authorization: "Bearer {apiKey}" },
      },
      usage: { readBy: "endpoint", url: USAGE_URL, headers: { authorization: "{apiKey}" } },
      harnesses: [ALPHA_HARNESS_ID],
    },
  ],
  defaultHarnessId: ALPHA_HARNESS_ID,
};

/**
 * Metered's usage body is `{ "used": 40 }` for a good answer, `{ "refuse": "..." }`
 * for a refusal, and anything else is a defect that the parser throws on.
 */
const METERED_PLUGINS: ReadonlyArray<Plugin> = [
  createPluginFixture({
    id: "metered",
    capabilities: ["providers"],
    definitions: [],
    providers: [METERED],
    providerOptions: {
      parseUsageBody: {
        "api-key": (body, takenAt) => {
          const answer = body as { used?: number; refuse?: string };
          if (typeof answer.refuse === "string") return { refused: answer.refuse };
          if (typeof answer.used !== "number") throw new Error("not a Metered answer");
          return {
            readings: [
              {
                kind: "window",
                window: "five-hour",
                usedPercent: answer.used,
                resetsAt: null,
                hit: false,
                takenAt,
              },
            ],
          };
        },
      },
    },
  }).plugin,
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const withService = <A, E, R>(
  body: (service: ProviderAccountService["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ProviderAccountService, body);

/** Reads the credential generation the account is on. */
const readGeneration = (accountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly credential_generation: number }>`
      SELECT credential_generation FROM provider_accounts WHERE id = ${uuidFromString(accountId)}`;
    return rows[0]?.credential_generation ?? -1;
  });

/** Counts the account-failed notifications. */
const countFailureNotifications = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM notifications WHERE kind = 'core.account-failed'`;
  return rows[0]?.count ?? 0;
});

/** Adds a Metered account holding the key `sk-live`. */
const addMeteredAccount = Effect.gen(function* () {
  const account = yield* addAccount({
    providerId: PROVIDER_ID,
    kind: "api-key",
    label: "Work",
  });
  yield* storeCredential(account.id, "apiKey", "sk-live");
  return account;
});

/**
 * Reads the usage of a new Metered account once, with the provider answering
 * `answer`, and returns the account as the user sees it and the requests sent.
 */
const readOnce = async (
  answer: () => FakeProviderAnswer,
  options: { readonly alreadyFailed?: boolean; readonly timeout?: Duration.Duration } = {},
) => {
  const api = buildFakeProviderApi(answer);
  const account = await runWithAccounts(
    Effect.gen(function* () {
      const added = yield* addMeteredAccount;
      if (options.alreadyFailed === true) {
        const generation = yield* readGeneration(added.id);
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, generation, "an earlier refusal"),
        );
      }
      yield* withService((service) => service.readUsageWithKey(added.id));
      return {
        account: yield* withService((service) => service.read(added.id)),
        notifications: yield* countFailureNotifications,
      };
    }).pipe(
      options.timeout === undefined
        ? (effect) => effect
        : Effect.provideService(UsageReadTimeout, options.timeout),
    ),
    api.client,
    METERED_PLUGINS,
  );
  return { ...account, requests: api.requests };
};

describe("ProviderAccountService.readUsageWithKey", () => {
  it("stores the readings and clears an earlier failure when the provider accepts the key", async () => {
    const { account, requests } = await readOnce(() => json({ used: 40 }), {
      alreadyFailed: true,
    });

    expect(account.failure).toBeNull();
    expect(account.usage).toMatchObject([
      { kind: "window", window: "five-hour", usedPercent: 40, hit: false, source: "read" },
    ]);
    // The raw key, as the kind declares it, and no redirect is followed.
    expect(requests).toEqual([
      { url: USAGE_URL, headers: { authorization: "sk-live" }, redirect: "manual" },
    ]);
  });

  it("fails the account with the provider's words on a 401, and raises one notification", async () => {
    const { account, notifications } = await readOnce(() => json({ msg: "Key revoked" }, 401));

    expect(account.failure).toMatchObject({ message: "Key revoked" });
    expect(account.usage).toEqual([]);
    expect(notifications).toBe(1);
  });

  it("fails the account with the status text when a 401 gives no words", async () => {
    const { account } = await readOnce(() => new Response("", { status: 401 }));

    expect(account.failure).toMatchObject({ message: "Unauthorized" });
  });

  it("fails the account with the plugin's words when it reads a 2xx answer as a refusal", async () => {
    const { account } = await readOnce(() => json({ refuse: "Authentication Failed" }));

    expect(account.failure).toMatchObject({ message: "Authentication Failed" });
    expect(account.usage).toEqual([]);
  });

  it.each([
    ["the provider cannot be reached", () => "unreachable" as const],
    ["the provider answers 403", () => json({ msg: "forbidden" }, 403)],
    ["the provider answers 429", () => json({ msg: "slow down" }, 429)],
    ["the provider answers 500", () => new Response("oops", { status: 500 })],
    ["the provider redirects", () => new Response(null, { status: 302 })],
    ["a 2xx answer is not JSON", () => new Response("<html>")],
    ["the plugin cannot read the answer", () => json({ surprise: true })],
  ])("keeps the account as it is when %s", async (_name, answer) => {
    const { account, notifications } = await readOnce(answer);

    expect(account.failure).toBeNull();
    expect(account.usage).toEqual([]);
    expect(notifications).toBe(0);
  });

  it("keeps a failure that was already recorded when the read does not answer", async () => {
    const { account } = await readOnce(() => "silent", {
      alreadyFailed: true,
      timeout: Duration.millis(20),
    });

    expect(account.failure).toMatchObject({ message: "an earlier refusal" });
  });

  it("does not fail a key that replaced the refused one while the read was in flight", async () => {
    const hook: { replaceKey: Effect.Effect<unknown> | undefined } = { replaceKey: undefined };
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url === USAGE_URL) {
          yield* hook.replaceKey ?? Effect.void;
          return HttpClientResponse.fromWeb(request, json({ msg: "Key revoked" }, 401));
        }
        return HttpClientResponse.fromWeb(request, json({}));
      }),
    );

    const account = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addMeteredAccount;
        const context = yield* Effect.context<ProviderAccountService>();
        hook.replaceKey = withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
        ).pipe(Effect.provideContext(context), Effect.orDie);
        yield* withService((service) => service.readUsageWithKey(added.id));
        return yield* withService((service) => service.read(added.id));
      }),
      client,
      METERED_PLUGINS,
    );

    expect(account.failure).toBeNull();
  });

  it("does nothing for an account that does not exist", async () => {
    const api = buildFakeProviderApi();
    await runWithAccounts(
      withService((service) => service.readUsageWithKey("0199e0e7-9999-7000-8000-000000000000")),
      api.client,
      METERED_PLUGINS,
    );

    expect(api.requests).toEqual([]);
  });

  it("sends nothing for an account without a stored key", async () => {
    const api = buildFakeProviderApi();
    await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ providerId: PROVIDER_ID, kind: "api-key" });
        yield* withService((service) => service.readUsageWithKey(added.id));
      }),
      api.client,
      METERED_PLUGINS,
    );

    expect(api.requests).toEqual([]);
  });
});
