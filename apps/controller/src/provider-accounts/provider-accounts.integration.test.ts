/**
 * Drives the harness, provider and providerAccount routes over HTTP. The
 * registry holds only the fixture plugins of `./testing`, so the listings
 * return what is written there rather than the plugins compiled into the
 * binary. What each operation decides is tested in `service.test.ts`; this
 * file tests that the routes reach it, with the right status and audit.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  collectPushes,
  completeSetup,
  del,
  expectHeld,
  fetchTicket,
  get,
  onSocket,
  post,
  send,
  waitForLiveToSettle,
  waitWithin,
  withServer,
  type ServerHarness,
} from "../http/testing";
import {
  ACME_PROVIDER_ID,
  addAccount,
  addAgent,
  ALPHA_HARNESS_ID,
  buildAccountPlugins,
  KEY_KIND,
  MACHINE_KIND,
} from "./testing";

/** A valid id that belongs to no account. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

interface AccountRecord {
  readonly id: string;
  readonly providerId: string;
  readonly kind: string;
  readonly label: string | null;
  readonly defaultHarnessId: string;
  readonly snapshots: ReadonlyArray<unknown>;
}

interface ApiError {
  readonly error: { readonly code: string; readonly message?: string; readonly details?: unknown };
}

const withAccounts = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
  withServer(body, { plugins: buildAccountPlugins() });

const readApiError = async (response: Response, status: number): Promise<ApiError> => {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as ApiError;
};

const listAccounts = async (base: string, token: string): Promise<ReadonlyArray<AccountRecord>> => {
  const response = await get(base, "/api/v1/provider-accounts", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<AccountRecord>;
};

/** Adds an account of Acme straight into the database, as the next ticket's create will. */
const insertAccount = async (
  sql: ServerHarness["sql"],
  account: Parameters<typeof addAccount>[0],
): Promise<AccountRecord["id"]> =>
  Effect.runPromise(
    Effect.orDie(Effect.provideService(addAccount(account), SqlClient.SqlClient, sql)),
  ).then((added) => added.id);

const readAudit = (
  sql: ServerHarness["sql"],
): Promise<ReadonlyArray<{ readonly kind: string; readonly actor: string | null }>> =>
  Effect.runPromise(
    Effect.orDie(
      sql<{ readonly kind: string; readonly actor: string | null }>`
        SELECT kind, actor FROM events WHERE kind LIKE 'providerAccount.%' ORDER BY id`,
    ),
  );

describe("GET /harnesses and /providers", () => {
  it("lists the registered harnesses and providers", async () => {
    await withAccounts(async ({ base }) => {
      const token = await completeSetup(base);

      const harnesses = (await (
        await get(base, "/api/v1/harnesses", token)
      ).json()) as ReadonlyArray<{
        readonly id: string;
        readonly runners: ReadonlyArray<unknown>;
      }>;
      const providers = (await (
        await get(base, "/api/v1/providers", token)
      ).json()) as ReadonlyArray<{
        readonly id: string;
        readonly kinds: ReadonlyArray<{ readonly id: string }>;
      }>;

      expect(harnesses.map((harness) => harness.id)).toEqual([ALPHA_HARNESS_ID, "beta/beta"]);
      expect(providers.map((provider) => provider.id)).toEqual([ACME_PROVIDER_ID]);
      expect(providers[0]?.kinds.map((kind) => kind.id)).toEqual([KEY_KIND, MACHINE_KIND]);
    });
  });

  it("refuses a request with no credential", async () => {
    await withAccounts(async ({ base }) => {
      expect((await get(base, "/api/v1/harnesses")).status).toBe(401);
      expect((await get(base, "/api/v1/providers")).status).toBe(401);
      expect((await get(base, "/api/v1/provider-accounts")).status).toBe(401);
    });
  });
});

describe("the provider account routes", () => {
  it("lists and reads accounts, and answers 404 for one that does not exist", async () => {
    await withAccounts(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const id = await insertAccount(sql, { kind: KEY_KIND, label: "work" });

      const listed = await listAccounts(base, token);
      expect(listed.map((account) => account.id)).toContain(id);

      const read = await get(base, `/api/v1/provider-accounts/${id}`, token);
      expect(read.status, await read.clone().text()).toBe(200);
      expect(await read.json()).toMatchObject({
        id,
        providerId: ACME_PROVIDER_ID,
        kind: KEY_KIND,
        label: "work",
        defaultHarnessId: ALPHA_HARNESS_ID,
        snapshots: [],
      });
      expect(
        (await readApiError(await get(base, `/api/v1/provider-accounts/${UNKNOWN_ID}`, token), 404))
          .error.code,
      ).toBe("not_found");
    });
  });

  it("renames an account, audits it, and answers 409 for a label another account has", async () => {
    await withAccounts(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const id = await insertAccount(sql, { label: "work" });
      await insertAccount(sql, { label: "home" });

      const renamed = await send("PATCH", base, `/api/v1/provider-accounts/${id}`, {
        body: { label: "office" },
        token,
      });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect(await renamed.json()).toMatchObject({ id, label: "office" });

      const clash = await readApiError(
        await send("PATCH", base, `/api/v1/provider-accounts/${id}`, {
          body: { label: "home" },
          token,
        }),
        409,
      );
      expect(clash.error.code).toBe("conflict");
      expect((await readAudit(sql)).at(-1)).toEqual({
        kind: "providerAccount.updated",
        actor: "user",
      });
    });
  });

  it("stores a key through update, and secret.set refuses the provider-account owner kind", async () => {
    await withAccounts(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const id = await insertAccount(sql, { kind: KEY_KIND });

      const stored = await send("PATCH", base, `/api/v1/provider-accounts/${id}`, {
        body: { credentials: { apiKey: "sk-a-paid-credential" } },
        token,
      });
      expect(stored.status, await stored.clone().text()).toBe(200);
      expect(await stored.text()).not.toContain("sk-a-paid-credential");

      const refused = await readApiError(
        await send("PUT", base, `/api/v1/secrets/provider-account/${id}/apiKey`, {
          body: { value: "sk-another" },
          token,
        }),
        400,
      );
      expect(refused.error.code).toBe("validation");
      expect(JSON.stringify(refused.error)).toContain("hercule provider-account update");
    });
  });

  it("refuses a delete with 409 while an Agent uses the account, and keeps the account", async () => {
    await withAccounts(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const id = await insertAccount(sql, { kind: KEY_KIND, label: "work" });
      await send("PATCH", base, `/api/v1/provider-accounts/${id}`, {
        body: { credentials: { apiKey: "sk-a-paid-credential" } },
        token,
      });
      await Effect.runPromise(
        Effect.orDie(Effect.provideService(addAgent(id, "Reviewer"), SqlClient.SqlClient, sql)),
      );

      const refused = await readApiError(
        await del(base, `/api/v1/provider-accounts/${id}`, token),
        409,
      );
      expect(refused.error.code).toBe("invalid_state");
      expect(refused.error.message).toContain('the Agent "Reviewer"');
      expect((await listAccounts(base, token)).map((account) => account.id)).toContain(id);
    });
  });

  it("deletes an unused account, with its stored key", async () => {
    await withAccounts(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const id = await insertAccount(sql, { kind: KEY_KIND });
      await send("PATCH", base, `/api/v1/provider-accounts/${id}`, {
        body: { credentials: { apiKey: "sk-a-paid-credential" } },
        token,
      });

      const deleted = await del(base, `/api/v1/provider-accounts/${id}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      expect((await listAccounts(base, token)).map((account) => account.id)).not.toContain(id);
      // A credential that outlived its owner would be inherited by whatever is given that id next.
      const left = await get(
        base,
        `/api/v1/secrets?ownerKind=provider-account&ownerId=${id}`,
        token,
      );
      expect(await left.json()).toEqual({ items: [] });
      expect((await readAudit(sql)).at(-1)).toEqual({
        kind: "providerAccount.deleted",
        actor: "user",
      });
    });
  });

  it("answers 404 when signing in or probing for an account or runner that does not exist", async () => {
    await withAccounts(async ({ base, sql }) => {
      const token = await completeSetup(base);
      const id = await insertAccount(sql, { kind: MACHINE_KIND });

      expect(
        (
          await readApiError(
            await post(
              base,
              `/api/v1/provider-accounts/${id}/sign-in`,
              { runnerId: UNKNOWN_ID },
              token,
            ),
            404,
          )
        ).error.code,
      ).toBe("not_found");
      expect(
        (
          await readApiError(
            await post(
              base,
              `/api/v1/runners/${UNKNOWN_ID}/probe`,
              { providerAccountId: id },
              token,
            ),
            404,
          )
        ).error.code,
      ).toBe("not_found");
    });
  });
});

describe("live messages about a provider account", () => {
  it("sends one invalidate message with the account id per update and delete", async () => {
    await withAccounts(async (harness) => {
      const token = await completeSetup(harness.base);
      const id = await insertAccount(harness.sql, { label: "work" });
      // The boot's announcements may still be in flight when the listener starts.
      await waitForLiveToSettle();
      const ticket = await fetchTicket(harness.base, token);

      let seen: ReadonlyArray<{ readonly _tag: string; readonly ids?: ReadonlyArray<string> }> = [];
      await onSocket(harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const accounts = yield* collectPushes(client, "provider");
          yield* Effect.promise(() => expectHeld(harness.live, 1, "provider"));

          // Changes are coalesced over a short window, so two writes back to
          // back would arrive as one message.
          const writes: ReadonlyArray<() => Promise<Response>> = [
            () =>
              send("PATCH", harness.base, `/api/v1/provider-accounts/${id}`, {
                body: { label: "renamed" },
                token,
              }),
            () => del(harness.base, `/api/v1/provider-accounts/${id}`, token),
          ];
          for (const [index, write] of writes.entries()) {
            const response = yield* Effect.promise(write);
            expect(response.status, yield* Effect.promise(() => response.text())).toBe(200);
            expect(
              yield* Effect.promise(() => waitWithin(2000, () => accounts.received.length > index)),
            ).toBe(true);
          }
          seen = accounts.received;
          yield* Fiber.interrupt(accounts.fiber);
        }),
      );

      expect(seen.map((message) => message._tag)).toEqual(["invalidate", "invalidate"]);
      expect(seen.map((message) => message.ids)).toEqual([[id], [id]]);
    });
  });
});
