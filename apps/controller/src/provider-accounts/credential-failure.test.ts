/**
 * Tests when a Provider Account becomes failed and when it warns that its
 * credential expires (spec 06 section 18.3), through the service, on a real
 * database and the real notifier.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidFromString } from "../db";
import { AccountUsage } from "../usage";
import { ProviderAccountService } from "./service";
import {
  addAccount,
  addRunner,
  ALPHA_HARNESS_ID,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  setTokenExpiry,
  TOKEN_KIND,
} from "./testing";

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

const DAY_MILLIS = 86_400_000;

const withService = <A, E, R>(
  body: (service: ProviderAccountService["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ProviderAccountService, body);

/** Returns the instant `days` days from now, as the ISO text an expiry is stored as. */
const inDays = (days: number): string => new Date(Date.now() + days * DAY_MILLIS).toISOString();

/** Reads the title and body of the notifications of one kind about the account, oldest first. */
const readNotificationsAbout = (kind: string, accountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly title: string; readonly body: string | null }>`
      SELECT notifications.title, notifications.body FROM notifications
      WHERE notifications.kind = ${kind}
        AND EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                    WHERE subject.value ->> 'kind' = 'providerAccount'
                      AND subject.value ->> 'id' = ${accountId})
      ORDER BY notifications.created_at, notifications.id`;
  });

/** Reads the credential generation the account is on, which a refusal is judged against. */
const readGeneration = (accountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly credential_generation: number }>`
      SELECT credential_generation FROM provider_accounts WHERE id = ${uuidFromString(accountId)}`;
    return rows[0]?.credential_generation ?? -1;
  });

/** Replaces the account's key, which the fake provider API accepts. */
const replaceKey = (accountId: string, apiKey: string) =>
  withService((service) => service.update({ id: accountId, credentials: { apiKey } }));

describe("recordCredentialRefused and recordCredentialAccepted", () => {
  it("fails the account with one notification, and a second refusal only updates the message", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND, label: "Work" });
        const generation = yield* readGeneration(added.id);
        const before = yield* withService((service) => service.read(added.id));
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, generation, "invalid key"),
        );
        const first = yield* withService((service) => service.read(added.id));
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, generation, "key revoked"),
        );
        return {
          before,
          first,
          second: yield* withService((service) => service.read(added.id)),
          notifications: yield* readNotificationsAbout("core.account-failed", added.id),
        };
      }),
    );

    expect(outcome.before.failure).toBeNull();
    expect(outcome.first.failure).toEqual({
      message: "invalid key",
      failedAt: expect.any(String) as unknown,
    });
    expect(outcome.second.failure).toEqual({
      message: "key revoked",
      failedAt: outcome.first.failure?.failedAt,
    });
    expect(outcome.notifications).toEqual([
      { title: "Acme · Work stopped working", body: "invalid key" },
    ]);
  });

  it("clears the failure when the credential is accepted, and a later refusal notifies again", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const generation = yield* readGeneration(added.id);
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, generation, "invalid key"),
        );
        yield* withService((service) => service.recordCredentialAccepted(added.id, generation));
        const cleared = yield* withService((service) => service.read(added.id));
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, generation, "invalid again"),
        );
        return {
          cleared,
          notifications: yield* readNotificationsAbout("core.account-failed", added.id),
        };
      }),
    );

    expect(outcome.cleared.failure).toBeNull();
    expect(outcome.notifications.map((notification) => notification.body)).toEqual([
      "invalid key",
      "invalid again",
    ]);
  });

  it("ignores an answer about an older credential, and about an account that is gone", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* replaceKey(added.id, "sk-old");
        const oldGeneration = yield* readGeneration(added.id);
        yield* replaceKey(added.id, "sk-new");
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, oldGeneration, "old key refused"),
        );
        const afterStaleRefusal = yield* withService((service) => service.read(added.id));
        const currentGeneration = yield* readGeneration(added.id);
        yield* withService((service) =>
          service.recordCredentialRefused(added.id, currentGeneration, "new key refused"),
        );
        yield* withService((service) => service.recordCredentialAccepted(added.id, oldGeneration));
        const afterStaleAcceptance = yield* withService((service) => service.read(added.id));
        yield* withService((service) => service.recordCredentialRefused(MISSING, 0, "gone"));
        yield* withService((service) => service.recordCredentialAccepted(MISSING, 0));
        return {
          afterStaleRefusal,
          afterStaleAcceptance,
          notifications: yield* readNotificationsAbout("core.account-failed", added.id),
        };
      }),
    );

    expect(outcome.afterStaleRefusal.failure).toBeNull();
    expect(outcome.afterStaleAcceptance.failure).toMatchObject({ message: "new key refused" });
    expect(outcome.notifications).toHaveLength(1);
  });

  it.each([
    {
      way: "a new key",
      kind: KEY_KIND,
      replace: (accountId: string) => replaceKey(accountId, "sk-new"),
    },
    {
      way: "a new token",
      kind: TOKEN_KIND,
      replace: (accountId: string) =>
        Effect.flatMap(addRunner("laptop"), (runner) =>
          withService((service) =>
            service.acceptSignIn(accountId, runner, ALPHA_HARNESS_ID, "tok-new"),
          ),
        ),
    },
    {
      way: "a sign-in on a machine",
      kind: MACHINE_KIND,
      replace: (accountId: string) =>
        Effect.flatMap(addRunner("laptop"), (runner) =>
          withService((service) =>
            service.acceptSignIn(accountId, runner, ALPHA_HARNESS_ID, undefined),
          ),
        ),
    },
  ])(
    "$way clears the failure and the expiry warning, so both fire again for it",
    async ({ kind, replace }) => {
      const outcome = await runWithAccounts(
        Effect.gen(function* () {
          const added = yield* addAccount({ kind });
          yield* setTokenExpiry(added.id, inDays(10));
          yield* withService((service) => service.notifyExpiring());
          const generation = yield* readGeneration(added.id);
          yield* withService((service) =>
            service.recordCredentialRefused(added.id, generation, "refused"),
          );
          yield* replace(added.id);
          const renewed = yield* withService((service) => service.read(added.id));
          // The new credential also gets a near expiry, as a short-lived one would.
          yield* setTokenExpiry(added.id, inDays(10));
          yield* withService((service) => service.notifyExpiring());
          const newGeneration = yield* readGeneration(added.id);
          yield* withService((service) =>
            service.recordCredentialRefused(added.id, newGeneration, "refused again"),
          );
          return {
            renewed,
            expiring: yield* readNotificationsAbout("core.account-expiring", added.id),
            failed: yield* readNotificationsAbout("core.account-failed", added.id),
          };
        }),
      );

      expect(outcome.renewed.failure).toBeNull();
      expect(outcome.expiring).toHaveLength(2);
      expect(outcome.failed).toHaveLength(2);
    },
  );
});

describe("notifyExpiring", () => {
  it("warns once for a credential within 14 days, with the days left and what to do", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const token = yield* addAccount({ kind: TOKEN_KIND, label: "Work" });
        const key = yield* addAccount({ kind: KEY_KIND, label: "Key" });
        yield* setTokenExpiry(token.id, inDays(12.5));
        yield* setTokenExpiry(key.id, inDays(12.5));
        yield* withService((service) => service.notifyExpiring());
        yield* withService((service) => service.notifyExpiring());
        return {
          token: yield* readNotificationsAbout("core.account-expiring", token.id),
          key: yield* readNotificationsAbout("core.account-expiring", key.id),
        };
      }),
    );

    expect(outcome.token).toEqual([
      {
        title: "Acme · Work expires in 13 days",
        body: "Its sessions stop working then. Make a new token for the account before that.",
      },
    ]);
    expect(outcome.key).toEqual([
      {
        title: "Acme · Key expires in 13 days",
        body: "Its sessions stop working then. Set a new key for the account before that.",
      },
    ]);
  });

  it("warns within 14 days, not at 15, and not for an account with no expiry", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const near = yield* addAccount({ kind: TOKEN_KIND, label: "near" });
        const far = yield* addAccount({ kind: TOKEN_KIND, label: "far" });
        const none = yield* addAccount({ kind: KEY_KIND, label: "none" });
        yield* setTokenExpiry(near.id, inDays(13.9));
        yield* setTokenExpiry(far.id, inDays(15));
        yield* withService((service) => service.notifyExpiring());
        return {
          near: yield* readNotificationsAbout("core.account-expiring", near.id),
          far: yield* readNotificationsAbout("core.account-expiring", far.id),
          none: yield* readNotificationsAbout("core.account-expiring", none.id),
        };
      }),
    );

    expect(outcome.near).toHaveLength(1);
    expect(outcome.far).toHaveLength(0);
    expect(outcome.none).toHaveLength(0);
  });

  it("warns once about a credential that has expired already", async () => {
    const notifications = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: TOKEN_KIND, label: "Work" });
        yield* setTokenExpiry(added.id, inDays(-3));
        yield* withService((service) => service.notifyExpiring());
        yield* withService((service) => service.notifyExpiring());
        return yield* readNotificationsAbout("core.account-expiring", added.id);
      }),
    );

    expect(notifications).toEqual([
      {
        title: "Acme · Work has expired",
        body: "Its sessions cannot start until you make a new token for the account.",
      },
    ]);
  });
});

describe("a new credential and the stored usage readings", () => {
  const fiveHour = () => ({
    kind: "window" as const,
    window: "five-hour" as const,
    usedPercent: 40,
    resetsAt: null,
    hit: false,
    takenAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const readUsageAfter = (
    kind: string,
    replace: (
      accountId: string,
      runnerId: string,
    ) => Effect.Effect<unknown, unknown, ProviderAccountService>,
  ) =>
    runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const added = yield* addAccount({ kind });
        const usage = yield* AccountUsage;
        yield* usage.record(added.id, [fiveHour()], "session");
        const before = yield* withService((service) => service.read(added.id));
        yield* replace(added.id, runner);
        const after = yield* withService((service) => service.read(added.id));
        return { before: before.usage, after: after.usage };
      }),
    );

  it("deletes the readings when a key is replaced", async () => {
    const { before, after } = await readUsageAfter(KEY_KIND, (id) => replaceKey(id, "sk-new"));

    expect(before).toHaveLength(1);
    expect(after).toEqual([]);
  });

  it("deletes the readings when a token is made", async () => {
    const { before, after } = await readUsageAfter(TOKEN_KIND, (id, runner) =>
      withService((service) => service.acceptSignIn(id, runner, ALPHA_HARNESS_ID, "tok-new")),
    );

    expect(before).toHaveLength(1);
    expect(after).toEqual([]);
  });

  it("keeps the readings after a sign-in on a machine", async () => {
    const { before, after } = await readUsageAfter(MACHINE_KIND, (id, runner) =>
      withService((service) => service.acceptSignIn(id, runner, ALPHA_HARNESS_ID, undefined)),
    );

    expect(after).toEqual(before);
  });
});
