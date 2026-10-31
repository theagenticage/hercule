import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../db";
import { isSignedIn, resolveProviderAccountHarness } from "./harness-choice";
import type { StoredSnapshot } from "./repository";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  SIGNED_IN,
} from "./testing";

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

describe("resolveProviderAccountHarness", () => {
  it("returns the account's default harness and its definition", async () => {
    const resolved = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        return yield* resolveProviderAccountHarness(account.id);
      }),
    );

    expect(resolved.harnessId).toBe(ALPHA_HARNESS_ID);
    expect(resolved.definition.id).toBe(ALPHA_HARNESS_ID);
  });

  it("does not read the account's snapshots, so one that cannot be decoded blocks nothing", async () => {
    const resolved = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        const laptop = yield* addRunner("laptop");
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, laptop);
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          sql`UPDATE capability_snapshots SET models = '"not a model list"'`,
        );
        return yield* resolveProviderAccountHarness(account.id);
      }),
    );

    expect(resolved.harnessId).toBe(ALPHA_HARNESS_ID);
  });

  it("treats a null harness as the account's default", async () => {
    const resolved = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        return yield* resolveProviderAccountHarness(account.id, null);
      }),
    );

    expect(resolved.harnessId).toBe(ALPHA_HARNESS_ID);
  });

  it("fails Validation on providerAccountId for an account that does not exist", async () => {
    const failure = await runWithAccounts(Effect.flip(resolveProviderAccountHarness(MISSING)));

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["providerAccountId"] }] } },
    });
  });

  it("fails Validation on harnessId for a harness this build does not carry", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        return yield* Effect.flip(resolveProviderAccountHarness(account.id, "gamma/gamma"));
      }),
    );

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["harnessId"] }] } },
    });
  });

  it("fails Validation on providerAccountId when the account's own default harness is not in this build", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ defaultHarnessId: "gamma/gamma" });
        return yield* Effect.flip(resolveProviderAccountHarness(account.id));
      }),
    );

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["providerAccountId"] }] } },
    });
  });

  it("fails Validation on harnessId, with the reason, for a harness the account cannot run in", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: MACHINE_KIND });
        return yield* Effect.flip(resolveProviderAccountHarness(account.id, BETA_HARNESS_ID));
      }),
    );

    expect(JSON.stringify(failure)).toContain("Acme does not allow Subscription accounts");
    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["harnessId"] }] } },
    });
  });
});

describe("isSignedIn", () => {
  const snapshot = (status: "ok" | "unauthenticated" | "error"): StoredSnapshot => ({
    providerAccountId: "a",
    harnessId: ALPHA_HARNESS_ID,
    runnerId: "r",
    probedAt: "2026-10-31T00:00:00.000Z",
    harnessVersion: null,
    auth: { ...SIGNED_IN.auth, status },
    models: [],
  });

  it("is true only for a snapshot whose auth is ok", () => {
    expect(isSignedIn(snapshot("ok"))).toBe(true);
    expect(isSignedIn(snapshot("unauthenticated"))).toBe(false);
    expect(isSignedIn(snapshot("error"))).toBe(false);
  });
});
