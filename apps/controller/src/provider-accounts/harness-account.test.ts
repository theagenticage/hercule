import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../db";
import { HarnessAccounts } from "./harness-account";
import {
  addAccount,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  giveLegacyHome,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  setTokenExpiry,
  storeCredential,
  TOKEN_KIND,
} from "./testing";

const prepareHarnessAccount = (providerAccountId: string, harnessId: string) =>
  Effect.flatMap(HarnessAccounts, (harnessAccounts) =>
    harnessAccounts.prepare(providerAccountId, harnessId),
  );

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

describe("HarnessAccounts.prepare", () => {
  it("sends the derived home, the model argument and the decrypted key for a key account", async () => {
    const account = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* storeCredential(added.id, "apiKey", "sk-secret");
        return { id: added.id, prepared: yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID) };
      }),
    );

    expect(account.prepared).toEqual({
      providerAccountId: account.id,
      harnessHome: `providers/homes/${account.id}/alpha/alpha`,
      modelArgument: "acme/{model}",
      credentialVariables: ["ACME_API_KEY"],
      credential: { variable: "ACME_API_KEY", value: "sk-secret" },
    });
  });

  it("fails InvalidState when the key account has no key stored, so the harness never falls back to another login", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND, label: "work" });
        return yield* Effect.flip(prepareHarnessAccount(added.id, ALPHA_HARNESS_ID));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Acme · work has no key. Add one in Settings › Providers.",
      },
    });
  });

  it("sends the harness's credential variables, and no credential, for a per-machine account", async () => {
    const prepared = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: MACHINE_KIND });
        yield* storeCredential(added.id, "apiKey", "sk-stray");
        return yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID);
      }),
    );

    expect(prepared.credentialVariables).toEqual(["ACME_API_KEY"]);
    expect(prepared).not.toHaveProperty("credential");
  });

  it("sends the legacy folder for the harness the account's old login belonged to", async () => {
    const prepared = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: MACHINE_KIND });
        yield* giveLegacyHome(added.id, "0199e0e7-aaaa-7000-8000-000000000002", ALPHA_HARNESS_ID);
        return yield* prepareHarnessAccount(added.id, ALPHA_HARNESS_ID);
      }),
    );

    expect(prepared.harnessHome).toBe("providers/0199e0e7-aaaa-7000-8000-000000000002");
  });

  it("sends a derived home for a harness other than the legacy one", async () => {
    const { id, prepared } = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: MACHINE_KIND });
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
        yield* storeCredential(added.id, "apiKey", "sk-secret");
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

describe("HarnessAccounts.prepare for a token account", () => {
  /** Adds a token account with a stored token that expires at `expiresAt`. */
  const addTokenAccount = (expiresAt: string) =>
    Effect.gen(function* () {
      const added = yield* addAccount({ kind: TOKEN_KIND });
      yield* storeCredential(added.id, "token", "tok-1");
      yield* setTokenExpiry(added.id, expiresAt);
      return added.id;
    });

  it("sends the stored token as the credential while it has not expired", async () => {
    const prepared = await runWithAccounts(
      Effect.gen(function* () {
        const id = yield* addTokenAccount("2999-01-01T00:00:00.000Z");
        return yield* prepareHarnessAccount(id, ALPHA_HARNESS_ID);
      }),
    );

    expect(prepared.credential).toEqual({ variable: "ACME_API_KEY", value: "tok-1" });
  });

  it("fails InvalidState, with the date, for a token past its expiry", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const id = yield* addTokenAccount("2020-03-04T05:06:07.000Z");
        return yield* Effect.flip(prepareHarnessAccount(id, ALPHA_HARNESS_ID));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Acme's token expired on 2020-03-04. Make a new one in Settings › Providers.",
      },
    });
  });

  it("fails InvalidState, asking for a token and not a key, when none is stored", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: TOKEN_KIND });
        return yield* Effect.flip(prepareHarnessAccount(added.id, ALPHA_HARNESS_ID));
      }),
    );

    expect(failure).toMatchObject({
      error: { message: "Acme has no token. Make one in Settings › Providers." },
    });
  });
});

describe("HarnessAccounts.prepare for a token that does not decrypt", () => {
  it("asks for a new token, not for a key through `update`, which a token account refuses", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const added = yield* addAccount({ kind: TOKEN_KIND });
        yield* storeCredential(added.id, "token", "tok-1");
        yield* withTransaction(
          sql,
          sql`UPDATE secrets SET ciphertext = randomblob(length(ciphertext))`,
        );
        return yield* Effect.flip(prepareHarnessAccount(added.id, ALPHA_HARNESS_ID));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message:
          "the token stored for Acme could not be decrypted; make a new one in Settings › Providers",
      },
    });
  });
});

describe("HarnessAccounts.prepareSignIn", () => {
  it("sends no credential for a token account that has none or whose token expired, and never the old token", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const harnessAccounts = yield* HarnessAccounts;
        const added = yield* addAccount({ kind: TOKEN_KIND });
        const withoutToken = yield* harnessAccounts.prepareSignIn(added.id, ALPHA_HARNESS_ID);
        yield* storeCredential(added.id, "token", "old");
        yield* setTokenExpiry(added.id, "2020-01-01T00:00:00.000Z");
        const withExpiredToken = yield* harnessAccounts.prepareSignIn(added.id, ALPHA_HARNESS_ID);
        return { withoutToken, withExpiredToken };
      }),
    );

    for (const frame of [outcome.withoutToken, outcome.withExpiredToken]) {
      expect(frame.credentialVariables).toEqual(["ACME_API_KEY"]);
      expect(frame).not.toHaveProperty("credential");
    }
  });

  it("sends no credential for a key account either, and still refuses a pair that cannot run", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const harnessAccounts = yield* HarnessAccounts;
        const added = yield* addAccount({ kind: KEY_KIND });
        yield* storeCredential(added.id, "apiKey", "sk-secret");
        return {
          frame: yield* harnessAccounts.prepareSignIn(added.id, ALPHA_HARNESS_ID),
          refused: yield* Effect.flip(harnessAccounts.prepareSignIn(added.id, BETA_HARNESS_ID)),
        };
      }),
    );

    expect(outcome.frame).not.toHaveProperty("credential");
    expect(outcome.refused).toMatchObject({ error: { code: "invalid_state" } });
  });
});
