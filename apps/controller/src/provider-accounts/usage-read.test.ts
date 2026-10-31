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
import { buildAnnouncementRecorder } from "../db/testing";
import { AccountUsage } from "../usage";
import { ProviderKeyRequestTimeout } from "./provider-key-requests";
import { ProviderAccountService } from "./service";
import {
  addAccount,
  buildFakeProviderApi,
  buildMeteredPlugin,
  METERED_KEY_KIND,
  METERED_PROVIDER_ID,
  METERED_USAGE_URL,
  runWithAccounts,
  storeCredential,
  type FakeProviderAnswer,
} from "./testing";

const METERED_PLUGINS = [buildMeteredPlugin()];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** A 401 with the words a provider gives for refusing a key. */
const refusal = (message: string): Response => json({ error: { message } }, 401);

/** Returns the instant `days` from now, as the fixed-width UTC text a provider's expiry is stored as. */
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

const withService = <A, E, R>(
  body: (service: ProviderAccountService["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ProviderAccountService, body);

/** Reads the bodies of the account-failed notifications, oldest first. */
const readFailureNotificationBodies = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly body: string | null }>`
    SELECT body FROM notifications WHERE kind = 'core.account-failed'
    ORDER BY created_at, id`;
  return rows.map((row) => row.body);
});

/** Adds a Metered account holding the key `sk-live`. */
const addMeteredAccount = Effect.gen(function* () {
  const account = yield* addAccount({
    providerId: METERED_PROVIDER_ID,
    kind: METERED_KEY_KIND,
    label: "Work",
  });
  yield* storeCredential(account.id, "apiKey", "sk-live");
  return account;
});

/**
 * Reads the usage of a new Metered account once for each of `answers`, the
 * provider giving the next answer to each request, and returns the account
 * and the account-failed notifications as the user sees them after each read,
 * the requests sent, and the log lines.
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
      const added = yield* addMeteredAccount;
      if (options.key !== undefined) yield* storeCredential(added.id, "apiKey", options.key);
      const afterEach = [];
      for (let read = 0; read < answers.length; read++) {
        yield* withService((service) => service.readUsageWithKey(added.id));
        afterEach.push({
          account: yield* withService((service) => service.read(added.id)),
          notifications: yield* readFailureNotificationBodies,
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
    METERED_PLUGINS,
  );
  return { steps, requests: api.requests, logged };
};

/**
 * Reads the usage of a new Metered account once, with the provider answering
 * `answer`, and returns the account and the notifications as the user sees
 * them, the requests sent, and the log lines. With `alreadyFailed`, the
 * provider refused the key in an earlier read.
 */
const readOnce = async (
  answer: () => FakeProviderAnswer,
  options: {
    readonly alreadyFailed?: boolean;
    readonly timeout?: Duration.Duration;
    readonly key?: string;
  } = {},
) => {
  const { alreadyFailed, ...rest } = options;
  const { steps, requests, logged } = await readInSequence(
    alreadyFailed === true ? [() => refusal("an earlier refusal"), answer] : [answer],
    rest,
  );
  return { ...steps.at(-1)!, requests, logged };
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
    expect(requests.at(-1)).toEqual({
      url: METERED_USAGE_URL,
      headers: { authorization: "sk-live" },
      redirect: "manual",
    });
  });

  it("fails the account with the provider's words on a 401, and raises one notification", async () => {
    const { account, notifications } = await readOnce(() => refusal("Key revoked"));

    expect(account.failure).toMatchObject({ message: "Key revoked" });
    expect(account.usage).toEqual([]);
    expect(notifications).toEqual(["` Key revoked `"]);
  });

  it("raises no second notification for a refusal while the account is failed, and replaces the words", async () => {
    const { steps } = await readInSequence([
      () => refusal("invalid key"),
      () => refusal("key revoked"),
    ]);

    expect(steps[1]!.account.failure).toEqual({
      message: "key revoked",
      failedAt: steps[0]!.account.failure?.failedAt,
    });
    expect(steps[1]!.notifications).toEqual(["` invalid key `"]);
  });

  it("clears the failure when the provider accepts the key again, and a later refusal notifies again", async () => {
    const { steps } = await readInSequence([
      () => refusal("invalid key"),
      () => json({ used: 40 }),
      () => refusal("invalid again"),
    ]);

    expect(steps[1]!.account.failure).toBeNull();
    expect(steps[2]!.notifications).toEqual(["` invalid key `", "` invalid again `"]);
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
    expect(notifications).toEqual([]);
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
     * only after the key has been replaced. When `refuseNewKey` is true, the
     * new key is read before the first read ends, and the provider answers
     * that read with `newKeyAnswer`, a refusal unless given. Returns the
     * account as the user sees it afterwards.
     */
    const readWhileKeyIsReplaced = (
      answer: () => Response,
      refuseNewKey: boolean,
      newKeyAnswer: () => Response = () => refusal("the new key is refused"),
    ) => {
      const hook: { replaceKey: Effect.Effect<unknown> | undefined } = { replaceKey: undefined };
      let usageRequests = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url !== METERED_USAGE_URL) {
            return HttpClientResponse.fromWeb(request, json({}));
          }
          usageRequests += 1;
          // The first usage request is the read in flight. A second one reads the new key.
          if (usageRequests > 1) {
            return HttpClientResponse.fromWeb(request, newKeyAnswer());
          }
          yield* hook.replaceKey ?? Effect.void;
          return HttpClientResponse.fromWeb(request, answer());
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
            if (refuseNewKey) yield* withService((service) => service.readUsageWithKey(added.id));
          }).pipe(Effect.provideContext(context), Effect.orDie);
          yield* withService((service) => service.readUsageWithKey(added.id));
          return yield* withService((service) => service.read(added.id));
        }),
        client,
        METERED_PLUGINS,
      );
    };

    it("does not fail the new key with the refusal of the old one", async () => {
      const account = await readWhileKeyIsReplaced(() => refusal("Key revoked"), false);

      expect(account.failure).toBeNull();
    });

    it("stores none of the old key's expiry", async () => {
      const account = await readWhileKeyIsReplaced(
        () => json({ used: 40, expires: inDays(30) }),
        false,
      );

      expect(account.expiresAt).toBeNull();
    });

    it("stores none of the old key's readings and does not clear the new key's failure", async () => {
      const account = await readWhileKeyIsReplaced(() => json({ used: 40 }), true);

      expect(account.usage).toEqual([]);
      expect(account.failure).toMatchObject({ message: "the new key is refused" });
    });

    it("removes none of the new key's readings when the old key's answer has none", async () => {
      const account = await readWhileKeyIsReplaced(
        () => json({ empty: true }),
        true,
        () => json({ used: 50 }),
      );

      expect(account.usage).toMatchObject([
        { kind: "window", window: "five-hour", usedPercent: 50 },
      ]);
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
    expect(logged.join("\n")).toContain("the key holds characters a header cannot carry");
  });

  it.each([
    ["an image", "![x](https://evil.test/x.png)"],
    ["a link", "[click](https://evil.test)"],
  ])(
    "puts %s in the provider's words into the notification as plain text",
    async (_name, words) => {
      const { notifications } = await readOnce(() => json({ refuse: words }));

      // Inside inline code, markdown does not become an image or a link.
      expect(notifications).toEqual([`\` ${words} \``]);
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
        const added = yield* addAccount({
          providerId: METERED_PROVIDER_ID,
          kind: METERED_KEY_KIND,
        });
        yield* withService((service) => service.readUsageWithKey(added.id));
      }),
      api.client,
      METERED_PLUGINS,
    );

    expect(api.requests).toEqual([]);
  });
});

describe("the readings a usage read no longer reports", () => {
  /**
   * Reads the usage of a new Metered account once for each of `bodies`, with a
   * short wait before each so every read is taken at a later time. Returns the
   * account's readings after each read, and how often each read announced the
   * account.
   */
  const readBodies = async (bodies: ReadonlyArray<unknown>) => {
    let next = 0;
    const api = buildFakeProviderApi(() => json(bodies[next++]));
    const recorder = buildAnnouncementRecorder();
    return runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addMeteredAccount;
        const afterEach = [];
        for (let read = 0; read < bodies.length; read++) {
          yield* Effect.sleep("5 millis");
          const before = recorder.announced.length;
          yield* withService((service) => service.readUsageWithKey(added.id));
          afterEach.push({
            usage: (yield* withService((service) => service.read(added.id))).usage,
            announced: recorder.announced
              .slice(before)
              .filter((change) => change._tag === "record" && change.id === added.id).length,
          });
        }
        return afterEach;
      }).pipe(Effect.provide(recorder.listener)),
      api.client,
      METERED_PLUGINS,
    );
  };

  it("removes a window the provider stopped reporting, and announces the account", async () => {
    const steps = await readBodies([{ used: 40, weekly: 20 }, { used: 40 }]);

    expect(steps[0]!.usage.map((reading) => reading.kind === "window" && reading.window)).toEqual([
      "five-hour",
      "weekly",
    ]);
    expect(steps[1]!.usage).toMatchObject([{ kind: "window", window: "five-hour" }]);
    expect(steps[1]!.announced).toBe(1);
  });

  it("removes every reading when the provider accepts the key and reports none", async () => {
    const steps = await readBodies([{ used: 40, weekly: 20 }, { empty: true }, { used: 41 }]);

    expect(steps[1]!.usage).toEqual([]);
    expect(steps[1]!.announced).toBe(1);
    // The provider reports a window again, and it is stored again.
    expect(steps[2]!.usage).toMatchObject([{ window: "five-hour", usedPercent: 41 }]);
  });
});

describe("the expiry of a key, from the usage read", () => {
  /** Counts the notifications that warn of an expiring credential. */
  const countExpiryWarnings = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM notifications WHERE kind = 'core.account-expiring'`;
    return rows[0]!.n;
  });

  /**
   * Reads the usage of a new Metered account once for each of `bodies`, then
   * returns the account's expiry after each read, and the announcements of
   * the account that each read caused.
   */
  const readBodies = async (bodies: ReadonlyArray<unknown>) => {
    let next = 0;
    const api = buildFakeProviderApi(() => json(bodies[next++]));
    const recorder = buildAnnouncementRecorder();
    const steps = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addMeteredAccount;
        const afterEach = [];
        for (let read = 0; read < bodies.length; read++) {
          const before = recorder.announced.length;
          yield* withService((service) => service.readUsageWithKey(added.id));
          afterEach.push({
            expiresAt: (yield* withService((service) => service.read(added.id))).expiresAt,
            announced: recorder.announced
              .slice(before)
              .filter((change) => change._tag === "record" && change.id === added.id).length,
          });
        }
        return afterEach;
      }).pipe(Effect.provide(recorder.listener)),
      api.client,
      METERED_PLUGINS,
    );
    return steps;
  };

  it("stores the expiry the answer reports, and announces the account even when the readings are unchanged", async () => {
    const expiry = inDays(30);

    const steps = await readBodies([{ used: 40 }, { used: 40, expires: expiry }]);

    expect(steps[0]!.expiresAt).toBeNull();
    expect(steps[1]!.expiresAt).toBe(expiry);
    // The readings are the same as in the first read and were announced less than 5 minutes ago.
    expect(steps[1]!.announced).toBe(1);
  });

  it("does not announce an expiry that is the one stored", async () => {
    const expiry = inDays(30);

    const steps = await readBodies([
      { used: 40, expires: expiry },
      { used: 40, expires: expiry },
    ]);

    expect(steps[1]!.expiresAt).toBe(expiry);
    expect(steps[1]!.announced).toBe(0);
  });

  it("clears the stored expiry when the answer says the key does not expire, and keeps it when the answer says nothing", async () => {
    const expiry = inDays(30);

    const steps = await readBodies([
      { used: 40, expires: expiry },
      { used: 41 },
      { used: 41, expires: null },
    ]);

    expect(steps.map((step) => step.expiresAt)).toEqual([expiry, expiry, null]);
    expect(steps[2]!.announced).toBe(1);
  });

  it("warns again about a new expiry, but not twice about the same one", async () => {
    const expiry = inDays(10);
    const bodies = [
      { used: 40, expires: expiry },
      { used: 40, expires: expiry },
      { used: 40, expires: inDays(9) },
    ];
    let next = 0;
    const api = buildFakeProviderApi(() => json(bodies[next++]));

    const warnings = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addMeteredAccount;
        const counts = [];
        for (let read = 0; read < bodies.length; read++) {
          yield* withService((service) => service.readUsageWithKey(added.id));
          yield* withService((service) => service.notifyExpiring());
          counts.push(yield* countExpiryWarnings);
        }
        return counts;
      }),
      api.client,
      METERED_PLUGINS,
    );

    expect(warnings).toEqual([1, 1, 2]);
  });

  it("clears the expiry of the old key when the key is replaced, and makes the account due for a read at once", async () => {
    const expiry = inDays(30);
    const api = buildFakeProviderApi(() => json({ used: 40, expires: expiry }));

    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addMeteredAccount;
        yield* withService((service) => service.readUsageWithKey(added.id));
        const usage = yield* AccountUsage;
        const claimed = yield* usage.claimRead(added.id);
        const dueBefore = yield* usage.listDueAccounts([added.id]);
        const readBefore = yield* withService((service) => service.read(added.id));
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
        );
        const replaced = yield* withService((service) => service.read(added.id));
        const dueAfter = yield* usage.listDueAccounts([added.id]);
        yield* withService((service) => service.readUsageWithKey(added.id));
        const readAgain = yield* withService((service) => service.read(added.id));
        return { claimed, dueBefore, readBefore, replaced, dueAfter, readAgain, id: added.id };
      }),
      api.client,
      METERED_PLUGINS,
    );

    expect(outcome.claimed).toBe(true);
    expect(outcome.dueBefore).toEqual([]);
    expect(outcome.readBefore.expiresAt).toBe(expiry);
    expect(outcome.replaced.expiresAt).toBeNull();
    expect(outcome.dueAfter).toEqual([outcome.id]);
    // The new key's own read sets its expiry.
    expect(outcome.readAgain.expiresAt).toBe(expiry);
  });
});
