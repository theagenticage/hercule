/**
 * Tests the Provider Account operations on a real database and the real
 * plugin host. What a delete is refused for lives in rows other domains own,
 * so those rows are inserted straight into their tables.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidFromString, withTransaction } from "../db";
import { readEventsOfKind } from "../events/testing";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { providerAccountRepository } from "./repository";
import { ProviderAccountService } from "./service";
import {
  ACME_PROVIDER_ID,
  addAccount,
  addAgent,
  addRunner,
  addSession,
  addSnapshot,
  addUserWithThreadDefault,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  buildFakeProviderApi,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  setTextGenerationModel,
  TOKEN_KIND,
} from "./testing";

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

const withService = <A, E, R>(
  body: (service: ProviderAccountService["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ProviderAccountService, body);

const readSecretNames = (accountId: string) =>
  Effect.flatMap(Secrets, (secrets) =>
    Effect.map(secrets.refs("provider-account", [accountId]), (held) =>
      (held.get(accountId) ?? []).map((ref) => ref.name),
    ),
  );

/** Pins the account to a person, as the first `ok` probe that reports an identity does. */
const pinIdentity = (accountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    yield* withTransaction(
      sql,
      accounts.setIdentityIfUnset(accountId, "old@work.com", "Max", "2026-10-31T00:00:00.000Z"),
    );
  });

/** Reads how many credentials the account has had, which a probe is judged against. */
const readCredentialGeneration = (accountId: string) =>
  Effect.gen(function* () {
    const accounts = yield* providerAccountRepository;
    return Option.getOrThrow(yield* accounts.one(accountId)).credentialGeneration;
  });

describe("providerAccount.query and read", () => {
  it("lists accounts oldest first, with their snapshots, and none of the stored home fields", async () => {
    const listed = await runWithAccounts(
      Effect.gen(function* () {
        const first = yield* addAccount({ kind: MACHINE_KIND });
        const second = yield* addAccount({ kind: KEY_KIND, label: "work" });
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(first.id, ALPHA_HARNESS_ID, runner);
        const accounts = yield* withService((service) => service.query());
        return { accounts, ids: [first.id, second.id], runner };
      }),
    );

    expect(listed.accounts.map((account) => account.id)).toEqual(listed.ids);
    expect(listed.accounts[0]).toMatchObject({
      providerId: ACME_PROVIDER_ID,
      kind: MACHINE_KIND,
      label: null,
      identity: null,
      planLabel: null,
      defaultHarnessId: ALPHA_HARNESS_ID,
      snapshots: [
        {
          runnerId: listed.runner,
          harnessId: ALPHA_HARNESS_ID,
          harnessVersion: "1.2.3",
          versionVerdict: "unknown",
          auth: { status: "ok", identity: "someone@example.com" },
        },
      ],
    });
    expect(listed.accounts[1]?.snapshots).toEqual([]);
    for (const account of listed.accounts) {
      expect(Object.keys(account)).not.toContain("legacyHomeFolder");
      expect(Object.keys(account)).not.toContain("legacyHomeHarnessId");
    }
  });

  it("reads one account, and fails NotFound for one that does not exist", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ label: "work" });
        const read = yield* withService((service) => service.read(added.id));
        const missing = yield* withService((service) => Effect.flip(service.read(MISSING)));
        return { read, missing };
      }),
    );

    expect(outcome.read).toMatchObject({ providerId: ACME_PROVIDER_ID, label: "work" });
    expect(outcome.missing).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("providerAccount.update", () => {
  it("renames an account, stamps the user, and audits the changed field", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ label: "old" });
        const updated = yield* withService((service) =>
          service.update({ id: added.id, label: "new" }),
        );
        return { updated, id: added.id, audit: yield* readEventsOfKind("providerAccount.updated") };
      }),
    );

    expect(outcome.updated.label).toBe("new");
    expect(outcome.audit).toHaveLength(1);
    expect(outcome.audit[0]).toMatchObject({
      actor: "user",
      payload: { providerAccountId: outcome.id, fields: ["label"] },
    });
  });

  it("removes the label with null", async () => {
    const updated = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ label: "old" });
        return yield* withService((service) => service.update({ id: added.id, label: null }));
      }),
    );

    expect(updated.label).toBeNull();
  });

  it("refuses a label another account of the provider has, with Conflict", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        yield* addAccount({ label: "work" });
        const other = yield* addAccount({ label: "home" });
        return yield* withService((service) =>
          Effect.flip(service.update({ id: other.id, label: "work" })),
        );
      }),
    );

    expect(failure).toMatchObject({
      error: { code: "conflict", message: expect.stringContaining('"work"') as unknown },
    });
  });

  it("counts no label as one value: removing a label is refused while another account has none", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        yield* addAccount({ label: null });
        const other = yield* addAccount({ label: "home" });
        return yield* withService((service) =>
          Effect.flip(service.update({ id: other.id, label: null })),
        );
      }),
    );

    expect(failure).toMatchObject({
      error: { code: "conflict", message: expect.stringContaining("no label") as unknown },
    });
  });

  it("lets an account keep its own label", async () => {
    const updated = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ label: "work" });
        return yield* withService((service) => service.update({ id: added.id, label: "work" }));
      }),
    );

    expect(updated.label).toBe("work");
  });

  it("rejects an empty patch and an account that does not exist", async () => {
    const failures = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount();
        return {
          empty: yield* withService((service) => Effect.flip(service.update({ id: added.id }))),
          missing: yield* withService((service) =>
            Effect.flip(service.update({ id: MISSING, label: "x" })),
          ),
        };
      }),
    );

    expect(failures.empty).toMatchObject({ error: { code: "validation" } });
    expect(failures.missing).toMatchObject({ error: { code: "not_found" } });
  });

  it("stores credentials as the account's Secrets, never returns them, and never audits their values", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const updated = yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-secret-value" } }),
        );
        const secrets = yield* Secrets;
        const stored = yield* secrets.get(buildProviderAccountOwner(added.id), "apiKey");
        return {
          updated,
          stored: Option.map(stored, Redacted.value),
          names: yield* readSecretNames(added.id),
          audit: yield* readEventsOfKind("providerAccount.updated"),
        };
      }),
    );

    expect(outcome.stored).toEqual(Option.some("sk-secret-value"));
    expect(outcome.names).toEqual(["apiKey"]);
    expect(JSON.stringify(outcome.updated)).not.toContain("sk-secret-value");
    expect(outcome.audit[0]?.payload["fields"]).toEqual(["credentials"]);
    expect(JSON.stringify(outcome.audit)).not.toContain("sk-secret-value");
  });

  it("replaces a stored key", async () => {
    const stored = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "first" } }),
        );
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "second" } }),
        );
        const secrets = yield* Secrets;
        return Option.map(
          yield* secrets.get(buildProviderAccountOwner(added.id), "apiKey"),
          Redacted.value,
        );
      }),
    );

    expect(stored).toEqual(Option.some("second"));
  });

  it("refuses credentials for a kind that has no credentials step, pointing at sign-in", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: MACHINE_KIND });
        const refused = yield* withService((service) =>
          Effect.flip(service.update({ id: added.id, credentials: { apiKey: "x" } })),
        );
        return { refused, names: yield* readSecretNames(added.id) };
      }),
    );

    expect(failure.refused).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure.refused)).toContain("take no credentials");
    expect(failure.names).toEqual([]);
  });

  it("refuses a credential field the kind does not declare, naming the ones it does, and stores nothing", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const refused = yield* withService((service) =>
          Effect.flip(
            service.update({ id: added.id, credentials: { apiKey: "ok", token: "nope" } }),
          ),
        );
        return { refused, names: yield* readSecretNames(added.id) };
      }),
    );

    expect(JSON.stringify(failure.refused)).toContain("no credential field token");
    expect(JSON.stringify(failure.refused)).toContain("the fields are apiKey");
    expect(failure.names).toEqual([]);
  });

  it("refuses an empty credentials object", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        return yield* withService((service) =>
          Effect.flip(service.update({ id: added.id, credentials: {} })),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
  });
});

describe("providerAccount.delete", () => {
  it("deletes a clean account with its secrets and snapshots, and audits it", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const added = yield* addAccount({ kind: KEY_KIND, label: "work" });
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(added.id, ALPHA_HARNESS_ID, runner);
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-secret" } }),
        );
        // An ended session is history and does not block the delete.
        yield* addSession(added.id, "exited");

        const result = yield* withService((service) => service.delete(added.id));

        const accounts = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM provider_accounts`;
        const snapshots = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM capability_snapshots`;
        const sessions = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM sessions WHERE provider_account_id = ${uuidFromString(added.id)}`;
        return {
          result,
          id: added.id,
          accounts: accounts[0]?.n,
          snapshots: snapshots[0]?.n,
          sessions: sessions[0]?.n,
          secretNames: yield* readSecretNames(added.id),
          audit: yield* readEventsOfKind("providerAccount.deleted"),
        };
      }),
    );

    expect(outcome.result).toEqual({});
    expect(outcome.accounts).toBe(0);
    expect(outcome.snapshots).toBe(0);
    expect(outcome.secretNames).toEqual([]);
    // Past sessions keep the account id as history.
    expect(outcome.sessions).toBe(1);
    expect(outcome.audit).toHaveLength(1);
    expect(outcome.audit[0]).toMatchObject({
      actor: "user",
      payload: {
        providerAccountId: outcome.id,
        providerId: ACME_PROVIDER_ID,
        kind: KEY_KIND,
        label: "work",
      },
    });
  });

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      withService((service) => Effect.flip(service.delete(MISSING))),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  /**
   * Runs a delete of an account that something uses, and returns the refusal
   * together with whether the account and its key are still there.
   */
  const deleteWhileUsed = (
    arrange: (accountId: string) => Effect.Effect<void, unknown, SqlClient.SqlClient>,
  ) =>
    runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const added = yield* addAccount({ kind: KEY_KIND, label: "work" });
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-secret" } }),
        );
        yield* arrange(added.id);
        const refusal = yield* withService((service) => Effect.flip(service.delete(added.id)));
        const remaining = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM provider_accounts`;
        return {
          refusal,
          accounts: remaining[0]?.n,
          secretNames: yield* readSecretNames(added.id),
          audit: yield* readEventsOfKind("providerAccount.deleted"),
        };
      }),
    );

  it("is refused while an Agent uses the account, naming the Agent, and deletes nothing", async () => {
    const outcome = await deleteWhileUsed((id) => addAgent(id, "Reviewer"));

    expect(outcome.refusal).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining('the Agent "Reviewer"') as unknown,
      },
    });
    expect(outcome.accounts).toBe(1);
    expect(outcome.secretNames).toEqual(["apiKey"]);
    expect(outcome.audit).toEqual([]);
  });

  it("is refused while an assistant uses the account, naming the assistant", async () => {
    const outcome = await deleteWhileUsed((id) => addAgent(id, "Hercule", "assistant"));

    expect(outcome.refusal).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining('the assistant "Hercule"') as unknown,
      },
    });
  });

  it("is refused while the textGeneration.model setting names the account", async () => {
    const outcome = await deleteWhileUsed((id) =>
      setTextGenerationModel({ providerAccountId: id, model: "mini" }),
    );

    expect(outcome.refusal).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("textGeneration.model") as unknown,
      },
    });
  });

  it("is not refused for textGeneration.model set to automatic, or to another account", async () => {
    for (const value of ["automatic", "off", { providerAccountId: MISSING, model: "mini" }]) {
      const deleted = await runWithAccounts(
        Effect.gen(function* () {
          const added = yield* addAccount();
          yield* setTextGenerationModel(value);
          return yield* withService((service) => service.delete(added.id));
        }),
      );
      expect(deleted).toEqual({});
    }
  });

  it("is refused while any user's thread default names the account, however many users have one", async () => {
    const outcome = await deleteWhileUsed((id) =>
      Effect.gen(function* () {
        yield* addUserWithThreadDefault("one", Option.some(id));
        yield* addUserWithThreadDefault("two", Option.some(id));
        yield* addUserWithThreadDefault("three", Option.some(MISSING));
        yield* addUserWithThreadDefault("four", Option.none());
      }),
    );

    expect(outcome.refusal).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("2 users (thread.providerAccountId)") as unknown,
      },
    });
  });

  it("is not refused for a thread default that names another account", async () => {
    const deleted = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount();
        yield* addUserWithThreadDefault("one", Option.some(MISSING));
        return yield* withService((service) => service.delete(added.id));
      }),
    );

    expect(deleted).toEqual({});
  });

  it.each(["queued", "starting", "idle", "busy"] as const)(
    "is refused while a session is %s on the account",
    async (status) => {
      const outcome = await deleteWhileUsed((id) => addSession(id, status));

      expect(outcome.refusal).toMatchObject({
        error: {
          code: "invalid_state",
          message: expect.stringContaining(
            "1 session that is queued, starting, idle or busy",
          ) as unknown,
        },
      });
      expect(outcome.accounts).toBe(1);
    },
  );

  it("names every blocker at once, and says to change them first", async () => {
    const outcome = await deleteWhileUsed((id) =>
      Effect.gen(function* () {
        yield* addAgent(id, "Reviewer");
        yield* addAgent(id, "Planner");
        yield* addAgent(id, "Hercule", "assistant");
        yield* setTextGenerationModel({ providerAccountId: id, model: "mini" });
        yield* addUserWithThreadDefault("one", Option.some(id));
        yield* addSession(id, "busy");
        yield* addSession(id, "idle");
      }),
    );

    const message = (outcome.refusal as unknown as { error: { message: string } }).error.message;
    expect(message).toContain("Acme · work is still in use");
    expect(message).toContain("Change these first");
    expect(message).toContain('the Agents "Planner", "Reviewer"');
    expect(message).toContain('the assistant "Hercule"');
    expect(message).toContain("textGeneration.model");
    expect(message).toContain("1 user (thread.providerAccountId)");
    expect(message).toContain("2 sessions that are queued, starting, idle or busy");
  });
});

/** A provider API that refuses every key, with the words a real one uses. */
const refusingProvider = () =>
  buildFakeProviderApi(
    () =>
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }),
  );

const readStoredSecret = (accountId: string, name: string) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    return Option.map(
      yield* secrets.get(buildProviderAccountOwner(accountId), name),
      Redacted.value,
    );
  });

const countAccounts = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT count(*) AS n FROM provider_accounts`,
    (rows) => rows[0]?.n,
  ),
);

describe("providerAccount.create", () => {
  it("checks the key, then stores the account, its key as a Secret and an audit entry without the key", async () => {
    const provider = buildFakeProviderApi();
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const created = yield* withService((service) =>
          service.create({
            providerId: ACME_PROVIDER_ID,
            kind: KEY_KIND,
            credentials: { apiKey: "sk-secret-value" },
          }),
        );
        return {
          created,
          stored: yield* readStoredSecret(created.id, "apiKey"),
          audit: yield* readEventsOfKind("providerAccount.created"),
        };
      }),
      provider.client,
    );

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.headers["authorization"]).toBe("Bearer sk-secret-value");
    expect(outcome.created).toMatchObject({
      providerId: ACME_PROVIDER_ID,
      kind: KEY_KIND,
      label: null,
      defaultHarnessId: ALPHA_HARNESS_ID,
      expiresAt: null,
      snapshots: [],
    });
    expect(outcome.stored).toEqual(Option.some("sk-secret-value"));
    expect(outcome.audit).toHaveLength(1);
    expect(outcome.audit[0]).toMatchObject({
      actor: "user",
      payload: { providerAccountId: outcome.created.id, kind: KEY_KIND },
    });
    expect(JSON.stringify(outcome.audit)).not.toContain("sk-secret-value");
    expect(JSON.stringify(outcome.created)).not.toContain("sk-secret-value");
  });

  it("stores nothing when the provider refuses the key: no row, no Secret, no audit entry", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const failure = yield* withService((service) =>
          Effect.flip(
            service.create({
              providerId: ACME_PROVIDER_ID,
              kind: KEY_KIND,
              credentials: { apiKey: "sk-bad" },
            }),
          ),
        );
        const sql = yield* SqlClient.SqlClient;
        const secrets = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM secrets`;
        return {
          failure,
          accounts: yield* countAccounts,
          secrets: secrets[0]?.n,
          audit: yield* readEventsOfKind("providerAccount.created"),
        };
      }),
      refusingProvider().client,
    );

    expect(outcome.failure).toMatchObject({
      error: { code: "validation", message: "invalid x-api-key" },
    });
    expect(outcome.accounts).toBe(0);
    expect(outcome.secrets).toBe(0);
    expect(outcome.audit).toEqual([]);
  });

  it.each([
    ["cannot be reached", () => "unreachable" as const],
    ["answers HTTP 500", () => new Response("down", { status: 500 })],
  ])("fails InvalidState and stores nothing when the provider %s", async (_name, answer) => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const failure = yield* withService((service) =>
          Effect.flip(
            service.create({
              providerId: ACME_PROVIDER_ID,
              kind: KEY_KIND,
              credentials: { apiKey: "sk-1" },
            }),
          ),
        );
        return { failure, accounts: yield* countAccounts };
      }),
      buildFakeProviderApi(answer).client,
    );

    expect(outcome.failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(outcome.accounts).toBe(0);
  });

  it.each([MACHINE_KIND, TOKEN_KIND])(
    "creates a %s account with no credentials, sends no check and stores no Secret",
    async (kind) => {
      const provider = buildFakeProviderApi();
      const outcome = await runWithAccounts(
        Effect.gen(function* () {
          const created = yield* withService((service) =>
            service.create({ providerId: ACME_PROVIDER_ID, kind }),
          );
          return { created, names: yield* readSecretNames(created.id) };
        }),
        provider.client,
      );

      expect(outcome.created).toMatchObject({ kind, defaultHarnessId: ALPHA_HARNESS_ID });
      expect(outcome.names).toEqual([]);
      expect(provider.requests).toEqual([]);
    },
  );

  it("refuses credentials for a kind that signs in, and creates nothing", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const failure = yield* withService((service) =>
          Effect.flip(
            service.create({
              providerId: ACME_PROVIDER_ID,
              kind: TOKEN_KIND,
              credentials: { apiKey: "pasted" },
            }),
          ),
        );
        return { failure, accounts: yield* countAccounts };
      }),
    );

    expect(outcome.failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(outcome.failure)).toContain("Make a new token");
    expect(outcome.accounts).toBe(0);
  });

  it("requires the key for a key kind, and a known provider and kind", async () => {
    const failures = await runWithAccounts(
      Effect.gen(function* () {
        const create = (input: Parameters<ProviderAccountService["Service"]["create"]>[0]) =>
          withService((service) => Effect.flip(service.create(input)));
        return {
          noKey: yield* create({ providerId: ACME_PROVIDER_ID, kind: KEY_KIND }),
          badProvider: yield* create({ providerId: "nobody/nobody", kind: KEY_KIND }),
          badKind: yield* create({ providerId: ACME_PROVIDER_ID, kind: "gold" }),
        };
      }),
    );

    expect(failures.noKey).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failures.noKey)).toContain("apiKey");
    expect(JSON.stringify(failures.badProvider)).toContain("providerId");
    expect(JSON.stringify(failures.badKind)).toContain("api-key");
  });

  it("asks for a label when the provider already has an account, and refuses one that is taken", async () => {
    const failures = await runWithAccounts(
      Effect.gen(function* () {
        const create = (label?: string) =>
          withService((service) =>
            Effect.flip(
              service.create({
                providerId: ACME_PROVIDER_ID,
                kind: MACHINE_KIND,
                ...(label === undefined ? {} : { label }),
              }),
            ),
          );
        yield* addAccount({ kind: MACHINE_KIND });
        const unlabelled = yield* create();
        yield* withService((service) =>
          service.create({ providerId: ACME_PROVIDER_ID, kind: MACHINE_KIND, label: "work" }),
        );
        return { unlabelled, taken: yield* create("work") };
      }),
    );

    expect(failures.unlabelled).toMatchObject({
      error: {
        code: "validation",
        details: { issues: [{ message: "Give this one a name, so you can tell them apart." }] },
      },
    });
    expect(failures.taken).toMatchObject({
      error: { code: "conflict", message: expect.stringContaining('"work"') as unknown },
    });
  });

  it("refuses a labelled key before it is checked when the label is taken, so no request is sent", async () => {
    const provider = buildFakeProviderApi();
    await runWithAccounts(
      Effect.gen(function* () {
        yield* addAccount({ label: "work" });
        const failure = yield* withService((service) =>
          Effect.flip(
            service.create({
              providerId: ACME_PROVIDER_ID,
              kind: KEY_KIND,
              label: "work",
              credentials: { apiKey: "sk-1" },
            }),
          ),
        );
        expect(failure).toMatchObject({ error: { code: "conflict" } });
      }),
      provider.client,
    );

    expect(provider.requests).toEqual([]);
  });

  describe("defaultHarnessId", () => {
    const createWith = (defaultHarnessId: string) =>
      withService((service) =>
        service.create({
          providerId: ACME_PROVIDER_ID,
          kind: KEY_KIND,
          credentials: { apiKey: "sk-1" },
          defaultHarnessId,
        }),
      );

    it("is refused when the harness is installed on no runner", async () => {
      const failure = await runWithAccounts(Effect.flip(createWith(ALPHA_HARNESS_ID)));

      expect(failure).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["defaultHarnessId"] }] } },
      });
      expect(JSON.stringify(failure)).toContain("not installed on any connected machine");
    });

    it("is accepted when a runner has the harness", async () => {
      const created = await runWithAccounts(
        Effect.gen(function* () {
          yield* addRunner("laptop");
          return yield* createWith(ALPHA_HARNESS_ID);
        }),
      );

      expect(created.defaultHarnessId).toBe(ALPHA_HARNESS_ID);
    });

    it("is refused when the account cannot run in the harness, with the reason", async () => {
      const failure = await runWithAccounts(
        Effect.gen(function* () {
          yield* addRunner("laptop");
          return yield* Effect.flip(createWith(BETA_HARNESS_ID));
        }),
      );

      expect(JSON.stringify(failure)).toContain("cannot run Acme API key accounts");
    });
  });
});

describe("providerAccount.update with a key or a default harness", () => {
  it("changes nothing at all when the replacement key is refused: label, harness and key stay", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        yield* addRunner("laptop");
        const added = yield* addAccount({
          kind: KEY_KIND,
          label: "old",
          defaultHarnessId: BETA_HARNESS_ID,
        });
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-old" } }),
        );
        const failure = yield* withService((service) =>
          Effect.flip(
            service.update({
              id: added.id,
              label: "new",
              defaultHarnessId: ALPHA_HARNESS_ID,
              credentials: { apiKey: "sk-new" },
            }),
          ),
        );
        return {
          failure,
          account: yield* withService((service) => service.read(added.id)),
          key: yield* readStoredSecret(added.id, "apiKey"),
          audit: yield* readEventsOfKind("providerAccount.updated"),
        };
      }),
      // The first update's key passes, the second is refused.
      (() => {
        let calls = 0;
        return buildFakeProviderApi(() => {
          calls += 1;
          return calls === 1
            ? new Response("{}")
            : new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
                status: 401,
              });
        }).client;
      })(),
    );

    expect(outcome.failure).toMatchObject({ error: { code: "validation" } });
    expect(outcome.account).toMatchObject({ label: "old", defaultHarnessId: BETA_HARNESS_ID });
    expect(outcome.key).toEqual(Option.some("sk-old"));
    expect(outcome.audit).toHaveLength(1);
  });

  it("checks a replacement key before storing it, and stores it when the provider accepts", async () => {
    const provider = buildFakeProviderApi();
    const key = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
        );
        return yield* readStoredSecret(added.id, "apiKey");
      }),
      provider.client,
    );

    expect(provider.requests.map((request) => request.headers["authorization"])).toEqual([
      "Bearer sk-new",
    ]);
    expect(key).toEqual(Option.some("sk-new"));
  });

  it("clears the account's identity and plan when the key is replaced, so a key from another person can be probed ok", async () => {
    const account = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* pinIdentity(added.id);
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
        );
        return yield* withService((service) => service.read(added.id));
      }),
      buildFakeProviderApi().client,
    );

    expect(account).toMatchObject({ identity: null, planLabel: null });
  });

  it("advances the credential generation when the key is replaced, and not for a label change", async () => {
    const generations = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const start = yield* readCredentialGeneration(added.id);
        yield* withService((service) => service.update({ id: added.id, label: "work" }));
        const afterLabel = yield* readCredentialGeneration(added.id);
        yield* withService((service) =>
          service.update({ id: added.id, credentials: { apiKey: "sk-new" } }),
        );
        return [start, afterLabel, yield* readCredentialGeneration(added.id)];
      }),
      buildFakeProviderApi().client,
    );

    expect(generations).toEqual([0, 0, 1]);
  });

  it("keeps the identity when the update changes only the label", async () => {
    const account = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* pinIdentity(added.id);
        return yield* withService((service) => service.update({ id: added.id, label: "work" }));
      }),
    );

    expect(account).toMatchObject({ identity: "old@work.com", planLabel: "Max" });
  });

  it("changes the default harness to one the account can run in that a runner has", async () => {
    const updated = await runWithAccounts(
      Effect.gen(function* () {
        yield* addRunner("laptop");
        const added = yield* addAccount({ kind: KEY_KIND, defaultHarnessId: BETA_HARNESS_ID });
        return yield* withService((service) =>
          service.update({ id: added.id, defaultHarnessId: ALPHA_HARNESS_ID }),
        );
      }),
    );

    expect(updated.defaultHarnessId).toBe(ALPHA_HARNESS_ID);
  });

  it("refuses a default harness no runner has, and one the account cannot run in", async () => {
    const failures = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const notInstalled = yield* withService((service) =>
          Effect.flip(service.update({ id: added.id, defaultHarnessId: ALPHA_HARNESS_ID })),
        );
        yield* addRunner("laptop");
        const cannotRun = yield* withService((service) =>
          Effect.flip(service.update({ id: added.id, defaultHarnessId: BETA_HARNESS_ID })),
        );
        return { notInstalled, cannotRun };
      }),
    );

    expect(JSON.stringify(failures.notInstalled)).toContain(
      "not installed on any connected machine",
    );
    expect(JSON.stringify(failures.cannotRun)).toContain("cannot run Acme API key accounts");
  });

  it("refuses credentials for a token account and points at making a new token", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: TOKEN_KIND });
        return yield* withService((service) =>
          Effect.flip(service.update({ id: added.id, credentials: { apiKey: "pasted" } })),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(failure)).toContain("Make a new token");
  });
});

describe("sign-in: prepareSignIn and acceptSignIn", () => {
  it("prepares the harness, the login method and a frame account without a credential", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const machine = yield* addAccount({ kind: MACHINE_KIND });
        const token = yield* addAccount({ kind: TOKEN_KIND, label: "tok" });
        return {
          machine: yield* withService((service) => service.prepareSignIn(machine.id, runner)),
          token: yield* withService((service) => service.prepareSignIn(token.id, runner)),
        };
      }),
    );

    expect(outcome.machine).toMatchObject({ harnessId: ALPHA_HARNESS_ID, method: "sign-in" });
    expect(outcome.token).toMatchObject({ harnessId: ALPHA_HARNESS_ID, method: "create-token" });
    expect(outcome.token.harnessAccount).not.toHaveProperty("credential");
  });

  it("is refused for a key account, which has nothing to sign in to", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const added = yield* addAccount({ kind: KEY_KIND });
        return yield* withService((service) =>
          Effect.flip(service.prepareSignIn(added.id, runner)),
        );
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("no sign-in step") as unknown,
      },
    });
  });

  it("stores a made token as the account's Secret with an expiry a year away, and audits without it", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const added = yield* addAccount({ kind: TOKEN_KIND });
        yield* withService((service) =>
          service.acceptSignIn(added.id, runner, ALPHA_HARNESS_ID, "tok-secret"),
        );
        return {
          account: yield* withService((service) => service.read(added.id)),
          stored: yield* readStoredSecret(added.id, "token"),
          audit: yield* readEventsOfKind("providerAccount.signedIn"),
        };
      }),
    );

    expect(outcome.stored).toEqual(Option.some("tok-secret"));
    const days = (Date.parse(outcome.account.expiresAt ?? "") - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(367);
    expect(outcome.audit).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain("tok-secret".concat("x"));
    expect(JSON.stringify(outcome.audit)).not.toContain("tok-secret");
    expect(JSON.stringify(outcome.account)).not.toContain("tok-secret");
  });

  it("clears the identity when a new token is stored, and keeps it for a sign-in that makes no token", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const token = yield* addAccount({ kind: TOKEN_KIND });
        const machine = yield* addAccount({ kind: MACHINE_KIND, label: "m" });
        yield* pinIdentity(token.id);
        yield* pinIdentity(machine.id);
        yield* withService((service) =>
          service.acceptSignIn(token.id, runner, ALPHA_HARNESS_ID, "tok-new"),
        );
        yield* withService((service) =>
          service.acceptSignIn(machine.id, runner, ALPHA_HARNESS_ID, undefined),
        );
        return {
          token: yield* withService((service) => service.read(token.id)),
          machine: yield* withService((service) => service.read(machine.id)),
        };
      }),
    );

    expect(outcome.token).toMatchObject({ identity: null, planLabel: null });
    expect(outcome.machine).toMatchObject({ identity: "old@work.com", planLabel: "Max" });
  });

  it("advances the credential generation for every accepted sign-in, with a token or without", async () => {
    const generations = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const token = yield* addAccount({ kind: TOKEN_KIND });
        const machine = yield* addAccount({ kind: MACHINE_KIND, label: "m" });
        yield* withService((service) =>
          service.acceptSignIn(token.id, runner, ALPHA_HARNESS_ID, "tok-new"),
        );
        yield* withService((service) =>
          service.acceptSignIn(machine.id, runner, ALPHA_HARNESS_ID, undefined),
        );
        return [
          yield* readCredentialGeneration(token.id),
          yield* readCredentialGeneration(machine.id),
        ];
      }),
    );

    expect(generations).toEqual([1, 1]);
  });

  it("refuses a missing or empty token from a token flow, and records the plain sign-in without one", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const token = yield* addAccount({ kind: TOKEN_KIND });
        const machine = yield* addAccount({ kind: MACHINE_KIND, label: "m" });
        const accept = (id: string, value: string | undefined) =>
          withService((service) => service.acceptSignIn(id, runner, ALPHA_HARNESS_ID, value));
        const missing = yield* Effect.flip(accept(token.id, undefined));
        const empty = yield* Effect.flip(accept(token.id, ""));
        yield* accept(machine.id, undefined);
        return {
          missing,
          empty,
          audit: yield* readEventsOfKind("providerAccount.signedIn"),
          names: yield* readSecretNames(token.id),
        };
      }),
    );

    expect(outcome.missing).toMatchObject({ error: { code: "invalid_state" } });
    expect(outcome.empty).toMatchObject({ error: { code: "invalid_state" } });
    expect(outcome.names).toEqual([]);
    expect(outcome.audit).toHaveLength(1);
  });

  it("fails NotFound when the account was deleted meanwhile", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.acceptSignIn(MISSING, runner, ALPHA_HARNESS_ID, "tok")),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});
