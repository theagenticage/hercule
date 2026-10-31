/**
 * Tests Model Catalogs on a real database and the real plugin host: what a
 * read stores, what a failed or late read leaves alone, which reads are due
 * and where they go, and the readiness rows beside the catalog on the
 * account's record.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ModelDescriptor, ProbeResult } from "@hercule/protocol";
import { withTransaction } from "../db";
import { ModelProfileService } from "../model-profiles";
import { runWithProfiles } from "../model-profiles/testing";
import { ModelCatalogs, computeDefaultSelection } from "./model-catalogs";
import { ProviderAccountProbes } from "./probes";
import { providerAccountRepository } from "./repository";
import { ProviderAccountService } from "./service";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  setTokenExpiry,
  storeCredential,
  TOKEN_KIND,
} from "./testing";

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

const model = (slug: string, extra: Partial<ModelDescriptor> = {}): ModelDescriptor => ({
  slug,
  name: slug,
  imageInput: null,
  options: [],
  ...extra,
});

const signedInWith = (...models: ReadonlyArray<ModelDescriptor>): ProbeResult => ({
  harnessVersion: "1.2.3",
  auth: { status: "ok", identity: "someone@example.com" },
  models,
  usage: null,
});

const signedOut = (message?: string): ProbeResult => ({
  harnessVersion: "1.2.3",
  auth: { status: "unauthenticated", ...(message === undefined ? {} : { message }) },
  models: [],
  usage: null,
});

/** The time a probe was sent, `n` seconds into a fixed minute. */
const sentAt = (n: number): string => `2026-10-31T10:00:${String(n).padStart(2, "0")}.000Z`;

/** Stores a probe's result as the read of the account's catalog, as the controller daemon does. */
const recordRead = (
  runnerId: string,
  accountId: string,
  result: ProbeResult,
  sentSeconds: number,
  readsCatalog = true,
) =>
  Effect.flatMap(ProviderAccountProbes, (probes) =>
    probes.recordProbe(
      runnerId,
      accountId,
      ALPHA_HARNESS_ID,
      result,
      { sentAt: sentAt(sentSeconds), credentialGeneration: 0, readUsage: false },
      { readsCatalog },
    ),
  );

const readCatalog = (accountId: string) =>
  Effect.flatMap(ModelCatalogs, (catalogs) => catalogs.read(accountId));

/** Reads the profile "Main", which the migration made. */
const readMain = Effect.gen(function* () {
  const profiles = yield* ModelProfileService;
  const [main] = yield* profiles.query();
  return main!;
});

/** Puts the account into "Main" as a section that waits for the account's first catalog read. */
const joinMain = (accountId: string) =>
  Effect.gen(function* () {
    const profiles = yield* ModelProfileService;
    const main = yield* readMain;
    yield* profiles.update({
      id: main.id,
      expectedRevision: main.revision,
      name: main.name,
      accounts: [{ providerAccountId: accountId, harnessId: null }],
      defaultEntry: null,
      dismissedNewModels: [],
    });
  });

/** A key account with its key stored, ready on every runner that has the harness. */
const addKeyAccount = (label: string | null = null) =>
  Effect.gen(function* () {
    const account = yield* addAccount({ kind: KEY_KIND, label });
    yield* storeCredential(account.id, "apiKey");
    return account;
  });

describe("computeDefaultSelection", () => {
  const models = [
    model("old", { isLegacy: true }),
    model("new"),
    model("best", { isDefault: true }),
  ];

  it("selects the models that are not legacy, in order, and names the default among them", () => {
    expect(computeDefaultSelection({ defaultSelection: "current-models" }, models)).toEqual({
      models: ["new", "best"],
      defaultModel: "best",
    });
  });

  it("names no default when the default model is legacy", () => {
    const selection = computeDefaultSelection({ defaultSelection: "current-models" }, [
      model("a"),
      model("b", { isDefault: true, isLegacy: true }),
    ]);

    expect(selection).toEqual({ models: ["a"], defaultModel: null });
  });

  it("selects nothing for the provider rule none", () => {
    expect(computeDefaultSelection({ defaultSelection: "none" }, models)).toEqual({
      models: [],
      defaultModel: null,
    });
  });
});

describe("a catalog read", () => {
  it("stores the models with the time each was first seen, sets the read time and clears the error", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedOut("Sign in on a machine first."), 1);
        const failed = yield* readCatalog(account.id);
        yield* recordRead(runner, account.id, signedInWith(model("a"), model("b")), 2);
        return { failed, read: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.failed).toMatchObject({
      models: [],
      readAt: null,
      error: "Sign in on a machine first.",
    });
    expect(outcome.read.models.map((one) => one.slug)).toEqual(["a", "b"]);
    expect(outcome.read.readAt).not.toBeNull();
    expect(outcome.read.error).toBeNull();
    expect(outcome.read.models.map((one) => one.firstSeenAt)).toEqual([
      outcome.read.readAt,
      outcome.read.readAt,
    ]);
  });

  it("fills the account's section of Main on the first successful read, once: entries, default and revision", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* joinMain(account.id);
        const pending = yield* readMain;
        yield* recordRead(runner, account.id, signedOut(), 1);
        const afterFailure = yield* readMain;
        yield* recordRead(
          runner,
          account.id,
          signedInWith(model("old", { isLegacy: true }), model("new", { isDefault: true })),
          2,
        );
        const filled = yield* readMain;
        yield* recordRead(runner, account.id, signedInWith(model("other")), 3);
        yield* recordRead(runner, account.id, signedOut("Sign in on a machine first."), 4);
        return { account, pending, afterFailure, filled, last: yield* readMain };
      }),
    );

    expect(outcome.pending.accounts[0]).toMatchObject({ selectionPending: true, entries: [] });
    expect(outcome.afterFailure).toEqual(outcome.pending);
    // The legacy model is left out, and the model the harness marks as its default becomes Main's.
    expect(outcome.filled.accounts[0]?.entries.map((one) => one.model)).toEqual(["new"]);
    expect(outcome.filled.accounts[0]?.selectionPending).toBe(false);
    expect(outcome.filled.defaultEntry).toMatchObject({
      providerAccountId: outcome.account.id,
      model: "new",
    });
    expect(outcome.filled.revision).toBe(outcome.pending.revision + 1);
    // A later read, successful or not, does not fill the section again.
    expect(outcome.last.revision).toBe(outcome.filled.revision);
    expect(outcome.last.accounts[0]?.entries.map((one) => one.model)).toEqual(["new"]);
  });

  it("keeps the models and their read time when a later read fails, and records why", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedInWith(model("a"), model("b")), 1);
        const before = yield* readCatalog(account.id);
        yield* recordRead(runner, account.id, signedOut("Sign in on a machine first."), 2);
        return { before, after: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.after.models).toEqual(outcome.before.models);
    expect(outcome.after.readAt).toBe(outcome.before.readAt);
    expect(outcome.after.error).toBe("Sign in on a machine first.");
  });

  it("records a sign-in as someone else than the account's person as a failed read, saying who", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const accounts = yield* providerAccountRepository;
        const account = yield* addKeyAccount();
        yield* withTransaction(
          sql,
          accounts.setIdentityIfUnset(account.id, "owner@example.com", "Max", sentAt(0)),
        );
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedInWith(model("a")), 1);
        return yield* readCatalog(account.id);
      }),
    );

    expect(outcome.models).toEqual([]);
    expect(outcome.error).toContain(
      "Signed in as someone@example.com; this account is owner@example.com",
    );
  });

  it("keeps a model's first-seen time when the model leaves the catalog and comes back", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedInWith(model("a"), model("b")), 1);
        const first = yield* readCatalog(account.id);
        yield* Effect.sleep(Duration.millis(5));
        yield* recordRead(runner, account.id, signedInWith(model("a")), 2);
        const withoutB = yield* readCatalog(account.id);
        yield* Effect.sleep(Duration.millis(5));
        yield* recordRead(runner, account.id, signedInWith(model("a"), model("b"), model("c")), 3);
        return { first, withoutB, last: yield* readCatalog(account.id) };
      }),
    );

    const firstSeen = (catalog: typeof outcome.last, slug: string) =>
      catalog.models.find((one) => one.slug === slug)?.firstSeenAt;
    expect(outcome.withoutB.models.map((one) => one.slug)).toEqual(["a"]);
    expect(firstSeen(outcome.last, "b")).toBe(firstSeen(outcome.first, "b"));
    expect(firstSeen(outcome.last, "c")).toBe(outcome.last.readAt);
    expect(firstSeen(outcome.last, "c")).not.toBe(firstSeen(outcome.first, "b"));
  });

  it("ignores an answer to a probe sent before the outcome the catalog already holds", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const near = yield* addRunner("near");
        const far = yield* addRunner("far");
        // The probe sent second answers first; the one sent first answers last.
        yield* recordRead(near, account.id, signedInWith(model("newer")), 20);
        const afterNewer = yield* readCatalog(account.id);
        yield* recordRead(far, account.id, signedInWith(model("older")), 10);
        const afterOlderSuccess = yield* readCatalog(account.id);
        yield* recordRead(far, account.id, signedOut("late failure"), 5);
        return { afterNewer, afterOlderSuccess, final: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.afterOlderSuccess).toEqual(outcome.afterNewer);
    expect(outcome.final).toEqual(outcome.afterNewer);
    expect(outcome.final.models.map((one) => one.slug)).toEqual(["newer"]);
  });

  it("stores a read sent before a failure whose answer came first, and keeps the failure's error", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const near = yield* addRunner("near");
        const far = yield* addRunner("far");
        // The read sent second fails and answers first; the one sent first succeeds and answers last.
        yield* recordRead(near, account.id, signedOut("Sign in on a machine first."), 20);
        yield* recordRead(far, account.id, signedInWith(model("older")), 10);
        const afterOlderSuccess = yield* readCatalog(account.id);
        // A success sent even earlier is older than those models and is dropped.
        yield* recordRead(far, account.id, signedInWith(model("oldest")), 5);
        return { afterOlderSuccess, final: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.afterOlderSuccess.models.map((one) => one.slug)).toEqual(["older"]);
    expect(outcome.afterOlderSuccess.readAt).not.toBeNull();
    expect(outcome.afterOlderSuccess.error).toBe("Sign in on a machine first.");
    expect(outcome.final).toEqual(outcome.afterOlderSuccess);
  });

  it("is stored even when an ordinary probe sent after it was stored first, as a read but not as a snapshot", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        // An ordinary probe sent at 20s is stored; the forced read sent at 10s answers after it.
        yield* recordRead(runner, account.id, signedInWith(model("ordinary")), 20, false);
        const forced = yield* recordRead(runner, account.id, signedInWith(model("forced")), 10);
        return {
          forced,
          catalog: yield* readCatalog(account.id),
          snapshots: yield* Effect.flatMap(providerAccountRepository, (accounts) =>
            accounts.listSnapshots(account.id),
          ),
        };
      }),
    );

    expect(outcome.forced).toEqual({ _tag: "superseded" });
    expect(outcome.catalog.models.map((one) => one.slug)).toEqual(["forced"]);
    expect(outcome.snapshots.map((snapshot) => snapshot.models.map((one) => one.slug))).toEqual([
      ["ordinary"],
    ]);
  });

  it("refuses a read sent before the account's credential changed, even when its snapshot would be stale anyway", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedInWith(model("ordinary")), 20, false);
        // A sign-in advances the credential generation past the one the read was sent with.
        yield* probes.acceptDeviceSignIn(account.id, runner, ALPHA_HARNESS_ID);
        const refused = yield* recordRead(runner, account.id, signedInWith(model("old-key")), 10);
        return { refused, catalog: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.refused).toEqual({ _tag: "superseded" });
    expect(outcome.catalog).toMatchObject({ models: [], readAt: null, error: null });
  });

  it("keeps models whose slugs are names every object has, with the time each was first seen", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(
          runner,
          account.id,
          signedInWith(model("constructor"), model("__proto__"), model("toString")),
          1,
        );
        const first = yield* readCatalog(account.id);
        yield* Effect.sleep(Duration.millis(5));
        yield* recordRead(
          runner,
          account.id,
          signedInWith(model("constructor"), model("__proto__"), model("fresh")),
          2,
        );
        return { first, second: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.first.models.map((one) => [one.slug, one.firstSeenAt])).toEqual([
      ["constructor", outcome.first.readAt],
      ["__proto__", outcome.first.readAt],
      ["toString", outcome.first.readAt],
    ]);
    // The two that stayed keep their first time; the new one is first seen at the second read.
    expect(outcome.second.models.map((one) => [one.slug, one.firstSeenAt])).toEqual([
      ["constructor", outcome.first.readAt],
      ["__proto__", outcome.first.readAt],
      ["fresh", outcome.second.readAt],
    ]);
  });

  it("is made only by a probe sent as a catalog read", async () => {
    const catalog = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedInWith(model("a")), 1, false);
        return yield* readCatalog(account.id);
      }),
    );

    expect(catalog).toMatchObject({ models: [], readAt: null, error: null });
  });
});

describe("reading the stored catalogs", () => {
  it("lists every account, with an empty catalog for one that was never read, and fails NotFound for a missing account", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const catalogs = yield* ModelCatalogs;
        const read = yield* addKeyAccount();
        const unread = yield* addKeyAccount("second");
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, read.id, signedInWith(model("a")), 1);
        return {
          ids: [read.id, unread.id],
          all: yield* catalogs.listCatalogs(),
          missing: yield* Effect.flip(catalogs.read(MISSING)),
        };
      }),
    );

    expect(outcome.all.map((catalog) => catalog.providerAccountId)).toEqual(outcome.ids);
    expect(outcome.all.map((catalog) => catalog.models.length)).toEqual([1, 0]);
    expect(outcome.all[1]).toMatchObject({ readAt: null, error: null });
    expect(outcome.missing).toMatchObject({ error: { code: "not_found" } });
  });

  it("is what providerAccount.readCatalog returns, and what the account's record summarises", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const service = yield* ProviderAccountService;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        const before = yield* service.read(account.id);
        yield* recordRead(runner, account.id, signedInWith(model("a"), model("b")), 1);
        yield* recordRead(runner, account.id, signedOut("Sign in on a machine first."), 2);
        return {
          before,
          catalog: yield* service.readCatalog(account.id),
          record: (yield* service.query())[0]!,
        };
      }),
    );

    expect(outcome.before).toMatchObject({
      modelCount: 0,
      catalogReadAt: null,
      catalogError: null,
    });
    expect(outcome.catalog.models).toHaveLength(2);
    expect(outcome.record).toMatchObject({
      modelCount: 2,
      catalogReadAt: outcome.catalog.readAt,
      catalogError: "Sign in on a machine first.",
    });
  });

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      Effect.flatMap(ProviderAccountService, (service) =>
        Effect.flip(service.readCatalog(MISSING)),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("which catalog reads are due, and where they go", () => {
  const choose = (
    options: { force?: boolean; localRunnerId?: string; accountIds?: ReadonlyArray<string> } = {},
  ) =>
    Effect.flatMap(ModelCatalogs, (catalogs) =>
      catalogs.chooseDueReads({
        force: options.force ?? false,
        localRunnerId: options.localRunnerId,
        ...(options.accountIds === undefined ? {} : { accountIds: options.accountIds }),
      }),
    );

  it("reads a catalog that was never read, on the local runner when it can serve it, else on the first runner", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addKeyAccount();
        const first = yield* addRunner("first");
        const local = yield* addRunner("local");
        return {
          account,
          first,
          local,
          withLocal: yield* choose({ localRunnerId: local }),
          withoutLocal: yield* choose(),
        };
      }),
    );

    const pair = (runnerId: string) => ({
      reads: [{ runnerId, providerAccountId: outcome.account.id, harnessId: ALPHA_HARNESS_ID }],
      unserved: [],
    });
    expect(outcome.withLocal).toEqual(pair(outcome.local));
    expect(outcome.withoutLocal).toEqual(pair(outcome.first));
  });

  it("does not read a catalog read less than four hours ago, unless forced, and reads it when it is older", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* recordRead(runner, account.id, signedInWith(model("a")), 1);
        const fresh = yield* choose();
        const forced = yield* choose({ force: true });
        yield* withTransaction(
          sql,
          sql`UPDATE model_catalogs SET read_at = '2020-01-01T00:00:00.000Z'`,
        );
        return { fresh, forced, stale: yield* choose() };
      }),
    );

    expect(outcome.fresh.reads).toEqual([]);
    expect(outcome.forced.reads).toHaveLength(1);
    expect(outcome.stale.reads).toHaveLength(1);
  });

  it("only considers the accounts it is asked about", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const wanted = yield* addKeyAccount();
        yield* addKeyAccount("other");
        yield* addRunner("laptop");
        return { wanted, chosen: yield* choose({ accountIds: [wanted.id] }) };
      }),
    );

    expect(outcome.chosen.reads.map((read) => read.providerAccountId)).toEqual([outcome.wanted.id]);
  });

  it("never picks an offline runner, and says so when no runner is left", async () => {
    const chosen = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* addKeyAccount();
        yield* addRunner("laptop");
        yield* withTransaction(sql, sql`UPDATE runners SET connectivity = 'offline'`);
        return yield* choose();
      }),
    );

    expect(chosen.reads).toEqual([]);
    expect(chosen.unserved).toHaveLength(1);
    expect(chosen.unserved[0]?.message).toContain("Connect one to list this account's models");
  });

  it("says which harness to install when no machine has it, and keeps the models when that is recorded", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const catalogs = yield* ModelCatalogs;
        const probes = yield* ProviderAccountProbes;
        const account = yield* addKeyAccount();
        const bare = yield* addRunner("bare", { binaryPresent: false });
        // An earlier read, from when a machine still had the harness.
        yield* recordRead(bare, account.id, signedInWith(model("a")), 1);
        const chosen = yield* choose({ force: true });
        yield* catalogs.recordCatalogRead(
          account.id,
          { _tag: "failed", message: chosen.unserved[0]!.message },
          yield* probes.readProbeStamp(account.id, false),
        );
        return { chosen, catalog: yield* readCatalog(account.id) };
      }),
    );

    expect(outcome.chosen.reads).toEqual([]);
    expect(outcome.catalog.error).toContain("not installed on any connected machine");
    expect(outcome.catalog.models.map((one) => one.slug)).toEqual(["a"]);
  });

  it("tells a sign-in account that is signed in nowhere to sign in on a machine", async () => {
    const chosen = await runWithAccounts(
      Effect.gen(function* () {
        yield* addAccount({ kind: MACHINE_KIND });
        yield* addRunner("laptop");
        return yield* choose();
      }),
    );

    expect(chosen.reads).toEqual([]);
    expect(chosen.unserved[0]?.message).toContain("not signed in on any connected machine");
  });

  it("serves a sign-in account on the machine where it is signed in", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: MACHINE_KIND });
        yield* addRunner("other");
        const signedInRunner = yield* addRunner("laptop");
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, signedInRunner);
        return { signedInRunner, chosen: yield* choose() };
      }),
    );

    expect(outcome.chosen.reads.map((read) => read.runnerId)).toEqual([outcome.signedInRunner]);
  });
});

describe("the readiness rows of an account", () => {
  const readinessOf = (accountId: string) =>
    Effect.map(
      Effect.flatMap(ProviderAccountService, (service) => service.read(accountId)),
      (account) => account.readiness,
    );

  it("lists a key account as ready on each runner once its key is stored, one row per harness it may run in", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND });
        const laptop = yield* addRunner("laptop");
        const server = yield* addRunner("server");
        const withoutKey = yield* readinessOf(account.id);
        yield* storeCredential(account.id, "apiKey");
        return { laptop, server, withoutKey, withKey: yield* readinessOf(account.id) };
      }),
    );

    expect(outcome.withoutKey.map((row) => row.state)).toEqual([
      "credential-missing",
      "credential-missing",
    ]);
    // Beta is listed by the kind but runs nothing, so only Alpha has rows.
    expect(outcome.withKey).toEqual([
      { harnessId: ALPHA_HARNESS_ID, runnerId: outcome.laptop, state: "ready" },
      { harnessId: ALPHA_HARNESS_ID, runnerId: outcome.server, state: "ready" },
    ]);
    expect(outcome.withKey.some((row) => row.harnessId === BETA_HARNESS_ID)).toBe(false);
  });

  it("lists a token account as expired once its token has expired", async () => {
    const rows = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: TOKEN_KIND });
        yield* addRunner("laptop");
        yield* storeCredential(account.id, "token");
        yield* setTokenExpiry(account.id, "2020-01-01T00:00:00.000Z");
        return yield* readinessOf(account.id);
      }),
    );

    expect(rows.map((row) => row.state)).toEqual(["token-expired"]);
  });

  it("lists a per-machine account as ready only where it is signed in, and says what is wrong elsewhere", async () => {
    const outcome = await runWithAccounts(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const signedIn = yield* addRunner("signed-in");
        const signedOutRunner = yield* addRunner("signed-out");
        const bare = yield* addRunner("bare", { binaryPresent: false });
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, signedIn);
        return { signedIn, signedOutRunner, bare, rows: yield* readinessOf(account.id) };
      }),
    );

    expect(outcome.rows).toEqual([
      { harnessId: ALPHA_HARNESS_ID, runnerId: outcome.signedIn, state: "ready" },
      { harnessId: ALPHA_HARNESS_ID, runnerId: outcome.signedOutRunner, state: "not-signed-in" },
      { harnessId: ALPHA_HARNESS_ID, runnerId: outcome.bare, state: "harness-missing" },
    ]);
  });

  it("leaves a retired runner out", async () => {
    const rows = await runWithAccounts(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const account = yield* addKeyAccount();
        yield* addRunner("gone");
        yield* withTransaction(sql, sql`UPDATE runners SET lifecycle = 'retired'`);
        return yield* readinessOf(account.id);
      }),
    );

    expect(rows).toEqual([]);
  });
});

describe("deleting an account", () => {
  it("deletes its catalog and takes it out of the Model Profiles in the same transaction", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const service = yield* ProviderAccountService;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* joinMain(account.id);
        yield* recordRead(runner, account.id, signedInWith(model("a")), 1);
        const before = yield* readMain;
        yield* service.delete(account.id);
        return {
          before,
          after: yield* readMain,
          catalogRead: yield* Effect.flip(readCatalog(account.id)),
        };
      }),
    );

    expect(outcome.before.accounts).toHaveLength(1);
    expect(outcome.after.accounts).toEqual([]);
    expect(outcome.after.defaultEntry).toBeNull();
    expect(outcome.after.revision).toBe(outcome.before.revision + 1);
    expect(outcome.catalogRead).toMatchObject({ error: { code: "not_found" } });
  });
});
