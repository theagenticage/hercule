import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../db";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { findModels, ProviderAccountRunners } from "./account-runners";
import { providerAccountRepository, type StoredSnapshot } from "./repository";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  SIGNED_IN,
  TOKEN_KIND,
} from "./testing";

const LATER = "2999-01-01T00:00:00.000Z";
const EARLIER = "2000-01-01T00:00:00.000Z";

/** Stores a credential for the account under the Secret name its kind uses. */
const storeSecret = (accountId: string, name: "apiKey" | "token") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* Secrets;
    yield* withTransaction(
      sql,
      secrets.set(buildProviderAccountOwner(accountId), name, Redacted.make("a-secret")),
    );
  });

const setExpiry = (accountId: string, expiresAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    yield* withTransaction(sql, accounts.setCredentialExpiry(accountId, expiresAt, expiresAt));
  });

const listRunners = (accountId: string) =>
  Effect.flatMap(ProviderAccountRunners, (runners) => runners.list(accountId, ALPHA_HARNESS_ID));

describe("ProviderAccountRunners.list", () => {
  describe("an account that holds a key", () => {
    it("runs on every runner that has the harness, with no snapshot at all", async () => {
      const { available, withHarness } = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: KEY_KIND });
          yield* storeSecret(account.id, "apiKey");
          const first = yield* addRunner("first");
          const second = yield* addRunner("second");
          yield* addRunner("bare", { binaryPresent: false });
          yield* addRunner("silent", { saidHello: false });
          // A runner whose build has no adapter for the harness cannot run it.
          yield* addRunner("old-build", { adapters: [] });
          return { available: yield* listRunners(account.id), withHarness: [first, second] };
        }),
      );

      expect(available.runnerIds).toEqual(withHarness);
      expect(available.noRunnerMessage).toBeNull();
    });

    it("runs nowhere, and says the key is missing, when no Secret is stored", async () => {
      const available = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: KEY_KIND, label: "work" });
          yield* addRunner("laptop");
          return yield* listRunners(account.id);
        }),
      );

      expect(available.runnerIds).toEqual([]);
      expect(available.noRunnerMessage).toBe(
        "Acme · work has no key. Add one in Settings › Providers.",
      );
    });

    it("runs nowhere, and says the harness is not installed, when no runner has it", async () => {
      const available = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: KEY_KIND });
          yield* storeSecret(account.id, "apiKey");
          yield* addRunner("bare", { binaryPresent: false });
          return yield* listRunners(account.id);
        }),
      );

      expect(available.runnerIds).toEqual([]);
      expect(available.noRunnerMessage).toContain("is not installed on any connected machine");
    });
  });

  describe("an account that holds a token", () => {
    it("runs on every runner that has the harness while the token is valid", async () => {
      const { available, runner } = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: TOKEN_KIND });
          yield* storeSecret(account.id, "token");
          yield* setExpiry(account.id, LATER);
          const runner = yield* addRunner("laptop");
          return { available: yield* listRunners(account.id), runner };
        }),
      );

      expect(available.runnerIds).toEqual([runner]);
    });

    it("runs nowhere, and names the date, once the token has expired", async () => {
      const available = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: TOKEN_KIND });
          yield* storeSecret(account.id, "token");
          yield* setExpiry(account.id, EARLIER);
          yield* addRunner("laptop");
          return yield* listRunners(account.id);
        }),
      );

      expect(available.runnerIds).toEqual([]);
      expect(available.noRunnerMessage).toBe(
        "Acme's token expired on 2000-01-01. Make a new one in Settings › Providers.",
      );
    });
  });

  describe("an account signed in on each machine", () => {
    it("runs only where the harness is installed and the snapshot is ok", async () => {
      const { available, signedIn } = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: MACHINE_KIND });
          const signedIn = yield* addRunner("signed in");
          const refused = yield* addRunner("refused");
          // A runner that was never probed is not signed in.
          yield* addRunner("unprobed");
          const bare = yield* addRunner("bare", { binaryPresent: false });
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, signedIn);
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, refused, {
            ...SIGNED_IN,
            auth: { status: "unauthenticated" },
            models: [],
          });
          // A snapshot on a runner without the harness does not make it run there.
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, bare);
          return { available: yield* listRunners(account.id), signedIn };
        }),
      );

      expect(available.runnerIds).toEqual([signedIn]);
    });

    it("counts a snapshot only when it is of the account's person, or one side has no identity", async () => {
      const { available, same, unnamed } = await runWithAccounts(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const accounts = yield* providerAccountRepository;
          const account = yield* addAccount({ kind: MACHINE_KIND });
          const same = yield* addRunner("same");
          const unnamed = yield* addRunner("unnamed");
          const someoneElse = yield* addRunner("someone-else");
          const signedInAs = (identity?: string) => ({
            ...SIGNED_IN,
            auth: { status: "ok" as const, ...(identity === undefined ? {} : { identity }) },
          });
          // Stored before the account's person was pinned, as a migrated one is.
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, same, signedInAs("Me@Example.com"));
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, unnamed, signedInAs());
          yield* addSnapshot(
            account.id,
            ALPHA_HARNESS_ID,
            someoneElse,
            signedInAs("other@example.com"),
          );
          const before = yield* listRunners(account.id);
          yield* withTransaction(
            sql,
            accounts.setIdentityIfUnset(account.id, "me@example.com", undefined, EARLIER),
          );
          return { available: [before, yield* listRunners(account.id)], same, unnamed };
        }),
      );

      // While the account has no identity every ok snapshot counts.
      expect(available[0]!.runnerIds).toHaveLength(3);
      expect(available[1]!.runnerIds).toEqual([same, unnamed]);
    });

    it("says it is not signed in when the harness is installed but no snapshot is ok", async () => {
      const available = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: MACHINE_KIND });
          const laptop = yield* addRunner("laptop");
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, laptop, {
            ...SIGNED_IN,
            auth: { status: "unauthenticated" },
            models: [],
          });
          return yield* listRunners(account.id);
        }),
      );

      expect(available.runnerIds).toEqual([]);
      expect(available.noRunnerMessage).toBe(
        "Acme is not signed in on any connected machine; sign in from Settings › Providers",
      );
    });

    it("says the harness is not installed, not that it is signed out, when no runner has it", async () => {
      const available = await runWithAccounts(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: MACHINE_KIND });
          yield* addRunner("bare", { binaryPresent: false });
          return yield* listRunners(account.id);
        }),
      );

      expect(available.noRunnerMessage).toContain("is not installed on any connected machine");
    });
  });

  it("lists no runner, with the reason, for a harness the account cannot run in", async () => {
    const available = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: MACHINE_KIND });
        yield* addRunner("laptop");
        const runners = yield* ProviderAccountRunners;
        return yield* runners.list(account.id, "beta/beta");
      }),
    );

    expect(available.runnerIds).toEqual([]);
    expect(available.noRunnerMessage).toContain("Acme does not allow Subscription accounts");
  });
});

describe("findModels", () => {
  const model = (slug: string) => ({ slug, name: slug, imageInput: null, options: [] });
  const snapshot = (
    runnerId: string,
    status: "ok" | "unauthenticated",
    probedAt: string,
    slug: string,
  ): StoredSnapshot => ({
    providerAccountId: "account",
    harnessId: ALPHA_HARNESS_ID,
    runnerId,
    probedAt,
    harnessVersion: null,
    auth: { status },
    models: [model(slug)],
  });

  const snapshots = [
    snapshot("a", "ok", "2026-10-01T00:00:00.000Z", "old"),
    snapshot("b", "ok", "2026-10-02T00:00:00.000Z", "new"),
    snapshot("c", "unauthenticated", "2026-10-03T00:00:00.000Z", "refused"),
  ];

  it("returns the runner's own ok snapshot when it has one", () => {
    expect(findModels(snapshots, "a").map((one) => one.slug)).toEqual(["old"]);
  });

  it("returns the most recently probed ok snapshot when the runner has none of its own", () => {
    expect(findModels(snapshots, "other").map((one) => one.slug)).toEqual(["new"]);
    expect(findModels(snapshots, "c").map((one) => one.slug)).toEqual(["new"]);
    expect(findModels(snapshots).map((one) => one.slug)).toEqual(["new"]);
  });

  it("returns no models when no snapshot is ok", () => {
    expect(findModels([snapshot("c", "unauthenticated", "2026-10-03T00:00:00.000Z", "x")])).toEqual(
      [],
    );
    expect(findModels([], "a")).toEqual([]);
  });
});
