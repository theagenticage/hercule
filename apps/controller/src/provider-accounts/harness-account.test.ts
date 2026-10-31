import { describe, expect, it } from "vitest";
import { Effect, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../db";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { prepareHarnessAccount } from "./harness-account";
import {
  addAccount,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  giveLegacyHome,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
} from "./testing";

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

const storeKey = (accountId: string, value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* Secrets;
    yield* withTransaction(
      sql,
      secrets.set(buildProviderAccountOwner(accountId), "apiKey", Redacted.make(value)),
    );
  });

describe("prepareHarnessAccount", () => {
  it("sends the derived home, the model argument and the decrypted key for a key account", async () => {
    const account = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* storeKey(added.id, "sk-secret");
        return { id: added.id, prepared: yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID) };
      }),
    );

    expect(account.prepared).toEqual({
      providerAccountId: account.id,
      harnessHome: `providers/homes/${account.id}/alpha/alpha`,
      modelArgument: "acme/{model}",
      credential: { variable: "ACME_API_KEY", value: "sk-secret" },
    });
  });

  it("sends the variable alone when the key account has no key stored, so the runner removes its own", async () => {
    const prepared = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        return yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID);
      }),
    );

    expect(prepared.credential).toEqual({ variable: "ACME_API_KEY" });
    expect(prepared.credential).not.toHaveProperty("value");
  });

  it("sends no credential for a per-machine account, even when a key is stored under its id", async () => {
    const prepared = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: MACHINE_KIND });
        yield* storeKey(added.id, "sk-stray");
        return yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID);
      }),
    );

    expect(prepared).not.toHaveProperty("credential");
  });

  it("sends the legacy folder for the harness the account's old login belonged to", async () => {
    const prepared = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* giveLegacyHome(added.id, "0199e0e7-aaaa-7000-8000-000000000002", ALPHA_HARNESS_ID);
        return yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID);
      }),
    );

    expect(prepared.harnessHome).toBe("providers/0199e0e7-aaaa-7000-8000-000000000002");
  });

  it("sends a derived home for a harness other than the legacy one", async () => {
    const { id, prepared } = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        // The legacy folder belongs to beta, so alpha's home is derived.
        yield* giveLegacyHome(added.id, "0199e0e7-aaaa-7000-8000-000000000002", BETA_HARNESS_ID);
        return { id: added.id, prepared: yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID) };
      }),
    );

    expect(prepared.harnessHome).toBe(`providers/homes/${id}/alpha/alpha`);
  });

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      Effect.flip(prepareHarnessAccount(MISSING, ALPHA_HARNESS_ID)),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it("fails InvalidState when the provider does not allow the harness for the kind", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: MACHINE_KIND });
        return yield* Effect.flip(prepareHarnessAccount(added.id, BETA_HARNESS_ID));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("Acme does not allow Subscription accounts") as unknown,
      },
    });
  });

  it("fails InvalidState when the provider allows the harness but the harness does not run the provider", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        return yield* Effect.flip(prepareHarnessAccount(added.id, BETA_HARNESS_ID));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("cannot run Acme API key accounts") as unknown,
      },
    });
  });

  it("fails InvalidState for a harness this build does not carry", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        return yield* Effect.flip(prepareHarnessAccount(added.id, "gamma/gamma"));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("no gamma/gamma harness") as unknown,
      },
    });
  });

  it("fails InvalidState, naming the command that fixes it, when the stored key does not decrypt", async () => {
    const { id, failure } = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* storeKey(added.id, "sk-secret");
        yield* withTransaction(
          sql,
          sql`UPDATE secrets SET ciphertext = randomblob(length(ciphertext))`,
        );
        return {
          id: added.id,
          failure: yield* Effect.flip(prepareHarnessAccount(added.id, ALPHA_HARNESS_ID)),
        };
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining(
          `hercule provider-account update ${id} --credentials-stdin`,
        ) as unknown,
      },
    });
  });
});
