/**
 * Tests the Provider Account operations on a real database and the real
 * plugin host. What a delete is refused for lives in rows other domains own,
 * so those rows are inserted straight into their tables.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidFromString } from "../db";
import { readEventsOfKind } from "../events/testing";
import { buildProviderAccountOwner, Secrets } from "../secrets";
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
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  setTextGenerationModel,
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

describe("providerAccount.signIn", () => {
  it("is refused with InvalidState for a key account, which has nothing to sign in to", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.signIn({ id: added.id, runnerId: runner })),
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

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.signIn({ id: MISSING, runnerId: runner })),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("providerAccount.submitSignInCode", () => {
  it("is refused with InvalidState for a key account, before the runner is asked", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.submitSignInCode({ id: added.id, runnerId: runner, code: "abc" })),
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

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.submitSignInCode({ id: MISSING, runnerId: runner, code: "abc" })),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});
