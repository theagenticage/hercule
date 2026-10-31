/**
 * Tests `readUsageWithKey` through the Provider Account service, on a real
 * database and with the provider's API replaced at the `HttpClient` seam: what
 * is stored for each answer, and which answers fail the account.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Logger } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import { createPluginFixture } from "../plugins/testing";
import { ProviderAccountService } from "./service";
import { ProviderUsageEndpointTimeout } from "./usage-endpoint";
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
 * for a refusal, `{ "nothing": true }` returns nothing, and anything else is a
 * defect that the parser throws on.
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
          if ((body as { nothing?: boolean }).nothing === true) return undefined as never;
          if (typeof answer.used !== "number") {
            throw new Error("not a Metered answer\nsecond line \u001b[31mred");
          }
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

/** Reads the body of the account-failed notification, or `null` when there is none. */
const readFailureNotificationBody = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly body: string | null }>`
    SELECT body FROM notifications WHERE kind = 'core.account-failed'`;
  return rows[0]?.body ?? null;
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
  options: {
    readonly alreadyFailed?: boolean;
    readonly timeout?: Duration.Duration;
    readonly key?: string;
  } = {},
) => {
  const api = buildFakeProviderApi(answer);
  const logged: Array<string> = [];
  const account = await runWithAccounts(
    Effect.gen(function* () {
      const added = yield* addMeteredAccount;
      if (options.key !== undefined) yield* storeCredential(added.id, "apiKey", options.key);
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
        notificationBody: yield* readFailureNotificationBody,
      };
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
        : Effect.provideService(ProviderUsageEndpointTimeout, options.timeout),
    ),
    api.client,
    METERED_PLUGINS,
  );
  return { ...account, requests: api.requests, logged };
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
    const { account, notifications } = await readOnce(() =>
      json({ error: { message: "Key revoked" } }, 401),
    );

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

  describe("when the key is replaced while the read is in flight", () => {
    /**
     * Reads the usage of a Metered account whose provider answers `answer`
     * only after the key has been replaced, and the new key has been refused
     * (`aNewRefusal`) when `refuseNewKey` is true. Returns the account as the
     * user sees it afterwards.
     */
    const readWhileKeyIsReplaced = (answer: () => Response, refuseNewKey: boolean) => {
      const hook: { replaceKey: Effect.Effect<unknown> | undefined } = { replaceKey: undefined };
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url === USAGE_URL) {
            yield* hook.replaceKey ?? Effect.void;
            return HttpClientResponse.fromWeb(request, answer());
          }
          return HttpClientResponse.fromWeb(request, json({}));
        }),
      );
      return runWithAccounts(
        Effect.gen(function* () {
          const added = yield* addMeteredAccount;
          const context = yield* Effect.context<ProviderAccountService | SqlClient.SqlClient>();
          hook.replaceKey = Effect.gen(function* () {
            yield* withService((service) =>
              service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
            );
            if (refuseNewKey) {
              const generation = yield* readGeneration(added.id);
              yield* withService((service) =>
                service.recordCredentialRefused(added.id, generation, "the new key is refused"),
              );
            }
          }).pipe(Effect.provideContext(context), Effect.orDie);
          yield* withService((service) => service.readUsageWithKey(added.id));
          return yield* withService((service) => service.read(added.id));
        }),
        client,
        METERED_PLUGINS,
      );
    };

    it("does not fail the new key with the refusal of the old one", async () => {
      const account = await readWhileKeyIsReplaced(
        () => json({ error: { message: "Key revoked" } }, 401),
        false,
      );

      expect(account.failure).toBeNull();
    });

    it("stores none of the old key's readings and does not clear the new key's failure", async () => {
      const account = await readWhileKeyIsReplaced(() => json({ used: 40 }), true);

      expect(account.usage).toEqual([]);
      expect(account.failure).toMatchObject({ message: "the new key is refused" });
    });
  });

  it("keeps a bad answer of the plugin out of the stored readings", async () => {
    const { account, logged } = await readOnce(() => json({ used: 150 }));

    expect(account.usage).toEqual([]);
    expect(account.failure).toBeNull();
    expect(logged.join("\n")).toContain("the plugin returned something that is neither readings");
  });

  it("treats a parser that returns nothing as an unreadable answer", async () => {
    const { account, logged } = await readOnce(() => json({ nothing: true }), {
      alreadyFailed: true,
    });

    expect(account.usage).toEqual([]);
    expect(account.failure).toMatchObject({ message: "an earlier refusal" });
    expect(logged.join("\n")).toContain("the plugin returned something that is neither readings");
  });

  it("logs what a parser threw on one line, without control characters", async () => {
    const { logged } = await readOnce(() => json({ surprise: true }));

    const line = logged.find((message) => message.includes("not a Metered answer"));
    expect(line).toContain("not a Metered answer second line [31mred");
    expect(line?.includes("\n")).toBe(false);
    expect(line?.includes("\u001b")).toBe(false);
  });

  it("reads nothing with a stored key that a header cannot carry, and says so", async () => {
    const { account, requests, logged } = await readOnce(() => json({ used: 40 }), {
      key: "sk bad\nkey",
    });

    expect(requests).toEqual([]);
    expect(account.usage).toEqual([]);
    expect(logged.join("\n")).toContain("the stored key holds characters a header cannot carry");
  });

  it.each([
    ["an image", "![x](https://evil.test/x.png)"],
    ["a link", "[click](https://evil.test)"],
  ])(
    "puts %s in the provider's words into the notification as plain text",
    async (_name, words) => {
      const { notificationBody } = await readOnce(() => json({ refuse: words }));

      // Inside inline code, markdown does not become an image or a link.
      expect(notificationBody).toBe(`\` ${words} \``);
    },
  );

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
