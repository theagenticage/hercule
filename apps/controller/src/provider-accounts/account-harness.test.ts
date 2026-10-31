import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { isLoggedIn, resolveAccountHarness } from "./account-harness";
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

describe("resolveAccountHarness", () => {
  it("returns the account, the default harness and only the snapshots of that harness", async () => {
    const resolved = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        const laptop = yield* addRunner("laptop");
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, laptop);
        // A snapshot in another harness is not this pair's.
        yield* addSnapshot(account.id, BETA_HARNESS_ID, laptop);
        return { account, laptop, resolved: yield* resolveAccountHarness(account.id) };
      }),
    );

    expect(resolved.resolved.account).toEqual(resolved.account);
    expect(resolved.resolved.harnessId).toBe(ALPHA_HARNESS_ID);
    expect(resolved.resolved.definition.id).toBe(ALPHA_HARNESS_ID);
    expect(resolved.resolved.snapshots.map((snapshot) => snapshot.runnerId)).toEqual([
      resolved.laptop,
    ]);
    expect(resolved.resolved.snapshots.map((snapshot) => snapshot.harnessId)).toEqual([
      ALPHA_HARNESS_ID,
    ]);
  });

  it("treats a null harness as the account's default", async () => {
    const resolved = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        return yield* resolveAccountHarness(account.id, null);
      }),
    );

    expect(resolved.harnessId).toBe(ALPHA_HARNESS_ID);
  });

  it("fails Validation on providerAccountId for an account that does not exist", async () => {
    const failure = await runWithAccounts(Effect.flip(resolveAccountHarness(MISSING)));

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["providerAccountId"] }] } },
    });
  });

  it("fails Validation on harnessId for a harness this build does not carry", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        return yield* Effect.flip(resolveAccountHarness(account.id, "gamma/gamma"));
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
        return yield* Effect.flip(resolveAccountHarness(account.id));
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
        return yield* Effect.flip(resolveAccountHarness(account.id, BETA_HARNESS_ID));
      }),
    );

    expect(JSON.stringify(failure)).toContain("Acme does not allow Subscription accounts");
    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["harnessId"] }] } },
    });
  });
});

describe("isLoggedIn", () => {
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
    expect(isLoggedIn(snapshot("ok"))).toBe(true);
    expect(isLoggedIn(snapshot("unauthenticated"))).toBe(false);
    expect(isLoggedIn(snapshot("error"))).toBe(false);
  });
});
