/**
 * Tests the Model Profile operations through their service, on a real
 * database and the real plugin host.
 *
 * The fixture provider Acme has a key kind and a kind signed in on each
 * machine. Its harness `alpha/alpha` lists its own models, and `beta/beta`
 * runs nothing. The database starts with the profile "Main".
 */
import { describe, expect, it } from "vitest";
import { Clock, Effect, Option } from "effect";
import {
  MAX_DISMISSED_NEW_MODELS,
  MAX_DISMISSED_NEW_MODELS_SENT,
  MAX_MODEL_PROFILE_ACCOUNTS,
  MAX_MODEL_PROFILES,
  MAX_MODEL_PROFILE_SECTION_ENTRIES,
  type ModelProfile,
  type ModelProfileUpdateInput,
} from "@hercule/contract";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, nowIso, uuidFromString, withTransaction } from "../db";
import { readEventsOfKind } from "../events/testing";
import { ModelProfileMembership, ProviderAccountService } from "../provider-accounts";
import { ProjectService } from "../projects";
import {
  ACME_PROVIDER_ID,
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  buildAccountPlugins,
  buildMeteredPlugin,
  KEY_KIND,
  MACHINE_KIND,
  METERED,
  METERED_KEY_KIND,
  METERED_PROVIDER_ID,
  storeCredential,
} from "../provider-accounts/testing";
import type { Plugin } from "@hercule/plugin-host";
import { buildHarnessDefinition, createPluginFixture } from "../plugins/testing";
import { buildModel, runWithProfiles, storeCatalog } from "./testing";
import { modelProfileRepository } from "./repository";
import { ModelProfileService } from "./service";

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

const CURRENT = buildModel("current", { isDefault: true });
const SECOND = buildModel("second");
const OLD = buildModel("old", { isLegacy: true });

/** Reads the profile the migration made. */
const readMain = Effect.gen(function* () {
  const profiles = yield* ModelProfileService;
  const [main] = yield* profiles.query();
  return main!;
});

/**
 * Builds the payload that keeps `profile` as it is read. A test overrides the
 * parts it changes.
 */
const keep = (
  profile: ModelProfile,
  change: Partial<ModelProfileUpdateInput> = {},
): ModelProfileUpdateInput => ({
  expectedRevision: profile.revision,
  name: profile.name,
  accounts: profile.accounts.map((section) => ({
    providerAccountId: section.providerAccountId,
    harnessId: section.harnessId,
    entries: section.entries.map(({ providerAccountId, model, harnessId }) => ({
      providerAccountId,
      model,
      harnessId,
    })),
  })),
  defaultEntry: profile.defaultEntry,
  dismissedNewModels: profile.dismissedNewModels,
  ...change,
});

const entry = (providerAccountId: string, model: string, harnessId: string | null = null) => ({
  providerAccountId,
  model,
  harnessId,
});

const update = (profile: ModelProfile, change: Partial<ModelProfileUpdateInput>) =>
  Effect.flatMap(ModelProfileService, (profiles) =>
    profiles.update({ id: profile.id, ...keep(profile, change) }),
  );

/** Adds a key account, stores its key and its catalog, and returns its id. */
const addReadyKeyAccount = (label: string, models = [CURRENT, SECOND, OLD]) =>
  Effect.gen(function* () {
    const account = yield* addAccount({ kind: KEY_KIND, label });
    yield* storeCredential(account.id, "apiKey");
    yield* storeCatalog(account.id, models);
    return account.id;
  });

describe("modelProfile.update", () => {
  it("replaces the whole profile, raises the revision and audits the write", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        const main = yield* readMain;
        const written = yield* update(main, {
          name: "Daily",
          accounts: [
            {
              providerAccountId: accountId,
              harnessId: null,
              entries: [entry(accountId, "second"), entry(accountId, "current")],
            },
          ],
          defaultEntry: entry(accountId, "second"),
          dismissedNewModels: [{ providerAccountId: accountId, model: "future" }],
        });
        const reread = yield* readMain;
        return {
          accountId,
          written,
          reread,
          audit: yield* readEventsOfKind("modelProfile.updated"),
        };
      }),
    );

    expect(outcome.reread).toEqual(outcome.written);
    expect(outcome.written).toMatchObject({
      name: "Daily",
      revision: 2,
      defaultEntry: entry(outcome.accountId, "second"),
      dismissedNewModels: [{ providerAccountId: outcome.accountId, model: "future" }],
    });
    expect(outcome.written.accounts[0]?.entries.map((one) => one.model)).toEqual([
      "second",
      "current",
    ]);
    expect(outcome.audit).toHaveLength(1);
    expect(outcome.audit[0]).toMatchObject({
      actor: "user",
      payload: { modelProfileId: outcome.written.id, revision: 2 },
    });
  });

  it("refuses a stale revision with conflict, naming the current one", async () => {
    const failure = await runWithProfiles(
      Effect.gen(function* () {
        const main = yield* readMain;
        yield* update(main, { name: "First" });
        return yield* Effect.flip(update(main, { name: "Second" }));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "conflict",
        message:
          "The profile changed since you read it (now revision 2). Read it again and make your change on that.",
      },
    });
  });

  it("fails not_found for a profile that does not exist", async () => {
    const failure = await runWithProfiles(
      Effect.gen(function* () {
        const main = yield* readMain;
        const profiles = yield* ModelProfileService;
        return yield* Effect.flip(profiles.update({ id: MISSING, ...keep(main) }));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses a name another profile has with validation on name, and keeps conflict for a stale revision", async () => {
    const failure = await runWithProfiles(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const main = yield* readMain;
        const at = yield* nowIso;
        yield* withTransaction(
          sql,
          sql`
          INSERT INTO model_profiles (id, name, revision, body, created_at, updated_at)
          VALUES (${mintUuid()}, 'Work', 1,
                  '{"accounts":[],"defaultEntry":null,"dismissedNewModels":[]}', ${at}, ${at})
        `,
        );
        return yield* Effect.flip(update(main, { name: "Work" }));
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "validation",
        details: {
          issues: [{ path: ["name"], message: expect.stringContaining("Work") as unknown }],
        },
      },
    });
  });

  describe("bounds", () => {
    const tooMany = (count: number) => Array.from({ length: count });

    const refusedFor = (build: (accountId: string) => Partial<ModelProfileUpdateInput>) =>
      runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          return yield* Effect.flip(update(yield* readMain, build(accountId)));
        }),
      );

    it("refuses more accounts than the limit", async () => {
      const failure = await refusedFor((accountId) => ({
        accounts: tooMany(MAX_MODEL_PROFILE_ACCOUNTS + 1).map(() => ({
          providerAccountId: accountId,
          harnessId: null,
          entries: [],
        })),
        defaultEntry: null,
      }));

      expect(failure).toMatchObject({ error: { code: "validation" } });
    });

    it("refuses more entries in a section than the limit", async () => {
      const failure = await refusedFor((accountId) => ({
        accounts: [
          {
            providerAccountId: accountId,
            harnessId: null,
            entries: tooMany(MAX_MODEL_PROFILE_SECTION_ENTRIES + 1).map((_, index) =>
              entry(accountId, `model-${String(index)}`),
            ),
          },
        ],
        defaultEntry: entry(accountId, "model-0"),
      }));

      expect(failure).toMatchObject({ error: { code: "validation" } });
    });

    it("refuses more dismissed models than a request may carry", async () => {
      const failure = await refusedFor((accountId) => ({
        dismissedNewModels: tooMany(MAX_DISMISSED_NEW_MODELS_SENT + 1).map((_, index) => ({
          providerAccountId: accountId,
          model: `model-${String(index)}`,
        })),
      }));

      expect(failure).toMatchObject({ error: { code: "validation" } });
    });

    it("refuses a harness id that is empty or longer than a model slug", async () => {
      const empty = await refusedFor((accountId) => ({
        accounts: [{ providerAccountId: accountId, harnessId: "", entries: [] }],
        defaultEntry: null,
      }));
      const long = await refusedFor((accountId) => ({
        accounts: [
          {
            providerAccountId: accountId,
            harnessId: null,
            entries: [entry(accountId, "current", "h".repeat(513))],
          },
        ],
        defaultEntry: entry(accountId, "current", "h".repeat(513)),
      }));

      expect(empty).toMatchObject({ error: { code: "validation" } });
      expect(long).toMatchObject({ error: { code: "validation" } });
    });

    it("accepts the limits themselves", async () => {
      const written = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          return yield* update(yield* readMain, {
            accounts: [
              {
                providerAccountId: accountId,
                harnessId: null,
                entries: tooMany(MAX_MODEL_PROFILE_SECTION_ENTRIES).map((_, index) =>
                  entry(accountId, `model-${String(index)}`),
                ),
              },
            ],
            defaultEntry: entry(accountId, "model-0"),
            dismissedNewModels: tooMany(MAX_DISMISSED_NEW_MODELS).map((_, index) => ({
              providerAccountId: accountId,
              model: `gone-${String(index)}`,
            })),
          });
        }),
      );

      expect(written.accounts[0]?.entries).toHaveLength(MAX_MODEL_PROFILE_SECTION_ENTRIES);
      expect(written.dismissedNewModels).toHaveLength(MAX_DISMISSED_NEW_MODELS);
    });
  });

  describe("a model the harness is known not to list", () => {
    /** An account with a successful alpha probe that lists only `SECOND`. */
    const addProbedAccount = Effect.gen(function* () {
      const accountId = yield* addReadyKeyAccount("work");
      const runner = yield* addRunner("laptop");
      yield* addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
        harnessVersion: "1.2.3",
        usage: null,
        auth: { status: "ok" },
        models: [SECOND],
      });
      return accountId;
    });

    const section = (accountId: string, models: ReadonlyArray<string>) => ({
      providerAccountId: accountId,
      harnessId: null,
      entries: models.map((model) => entry(accountId, model)),
    });

    it("refuses an added entry, naming the model, and keeps an entry the profile already held", async () => {
      const outcome = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          // "current" goes in before any probe, so nothing can be known yet.
          const held = yield* update(yield* readMain, {
            accounts: [section(accountId, ["current"])],
            defaultEntry: entry(accountId, "current"),
          });
          const runner = yield* addRunner("laptop");
          yield* addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
            harnessVersion: "1.2.3",
            usage: null,
            auth: { status: "ok" },
            models: [SECOND],
          });
          const refused = yield* Effect.flip(
            update(held, { accounts: [section(accountId, ["current", "old"])] }),
          );
          const kept = yield* update(held, {
            accounts: [section(accountId, ["current", "second"])],
          });
          return { refused, kept };
        }),
      );

      expect(outcome.refused).toMatchObject({
        error: {
          code: "validation",
          details: {
            issues: [
              {
                path: ["accounts", "0", "entries", "1", "model"],
                message: expect.stringContaining("does not list old") as unknown,
              },
            ],
          },
        },
      });
      expect(
        outcome.kept.accounts[0]?.entries.map((one) => [one.model, one.problem?.reason]),
      ).toEqual([
        ["current", "harness-lacks-model"],
        ["second", undefined],
      ]);
    });

    it("says nothing while the account has no successful probe in the harness", async () => {
      const written = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          return yield* update(yield* readMain, {
            accounts: [section(accountId, ["old"])],
            defaultEntry: entry(accountId, "old"),
          });
        }),
      );

      expect(written.accounts[0]?.entries[0]?.problem?.reason).not.toBe("harness-lacks-model");
    });

    it("accepts an added entry the probe lists", async () => {
      const written = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addProbedAccount;
          return yield* update(yield* readMain, {
            accounts: [section(accountId, ["second"])],
            defaultEntry: entry(accountId, "second"),
          });
        }),
      );

      expect(written.accounts[0]?.entries[0]?.problem).toBeNull();
    });
  });

  describe("without the grant to read accounts", () => {
    const writerOnly: Actor = {
      _tag: "session",
      sessionId: "0199f0b7-0002-7000-8000-000000000000",
      profileId: "0199f0b7-0003-7000-8000-000000000000",
      grants: ["infra.write"],
      profileGrants: ["infra.write"],
      assistantId: null,
      agentId: null,
    };

    it("updates a profile and stamps the session, though providerAccount.query is not granted", async () => {
      const outcome = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          const main = yield* readMain;
          const written = yield* update(main, {
            accounts: [
              {
                providerAccountId: accountId,
                harnessId: null,
                entries: [entry(accountId, "current")],
              },
            ],
            defaultEntry: entry(accountId, "current"),
          }).pipe(Effect.provideService(CurrentActor, writerOnly));
          return { written, audit: yield* readEventsOfKind("modelProfile.updated") };
        }),
      );

      expect(outcome.written.accounts[0]?.entries[0]?.name).toBe("Model current");
      expect(outcome.audit[0]).toMatchObject({ actor: `session:${writerOnly.sessionId}` });
    });

    it("refuses a reader that lacks infra.read", async () => {
      const failure = await runWithProfiles(
        Effect.flatMap(ModelProfileService, (profiles) => profiles.query()).pipe(
          Effect.provideService(CurrentActor, { ...writerOnly, grants: ["infra.write"] }),
          Effect.flip,
        ),
      );

      expect(failure).toMatchObject({ error: { code: "forbidden" } });
    });
  });

  describe("refuses with validation", () => {
    const refusal = (
      build: (accountId: string, otherId: string) => Partial<ModelProfileUpdateInput>,
    ) =>
      runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          const machineId = (yield* addAccount({ kind: MACHINE_KIND, label: "home" })).id;
          const main = yield* readMain;
          return yield* Effect.flip(update(main, build(accountId, machineId)));
        }),
      );

    const section = (
      providerAccountId: string,
      entries: ReadonlyArray<ReturnType<typeof entry>>,
      harnessId: string | null = null,
    ) => ({
      providerAccountId,
      harnessId,
      entries,
    });

    const issues = (failure: unknown): ReadonlyArray<string> =>
      (
        failure as { error: { details: { issues: ReadonlyArray<{ message: string }> } } }
      ).error.details.issues.map((issue) => issue.message);

    it("an account that does not exist", async () => {
      const failure = await refusal(() => ({
        accounts: [section(MISSING, [])],
        defaultEntry: null,
      }));

      expect(failure).toMatchObject({ error: { code: "validation" } });
      expect(issues(failure)).toEqual(["no such provider account"]);
    });

    it("an account in two sections", async () => {
      const failure = await refusal((accountId) => ({
        accounts: [section(accountId, []), section(accountId, [])],
        defaultEntry: null,
      }));

      expect(issues(failure)).toEqual([expect.stringContaining("in the profile twice")]);
    });

    it("an entry of another account than its section's", async () => {
      const failure = await refusal((accountId, machineId) => ({
        accounts: [section(accountId, [entry(machineId, "current")])],
        defaultEntry: entry(machineId, "current"),
      }));

      expect(issues(failure)).toEqual([expect.stringContaining("account of the section")]);
    });

    it("the same model twice in one harness, whether the harness is named or inherited", async () => {
      const failure = await refusal((accountId) => ({
        accounts: [
          section(accountId, [
            entry(accountId, "current"),
            entry(accountId, "current", ALPHA_HARNESS_ID),
          ]),
        ],
        defaultEntry: entry(accountId, "current"),
      }));

      expect(issues(failure)).toEqual([
        expect.stringMatching(
          /^current is already in this section in Harness \w+; an account's model appears once per harness$/,
        ),
      ]);
    });

    it("a harness the account's kind does not allow", async () => {
      const failure = await refusal((_, machineId) => ({
        accounts: [section(machineId, [entry(machineId, "current", BETA_HARNESS_ID)])],
        defaultEntry: entry(machineId, "current", BETA_HARNESS_ID),
      }));

      expect(issues(failure)).toEqual([expect.stringContaining("does not allow")]);
    });

    it("a section harness the harness cannot run the account in", async () => {
      const failure = await refusal((accountId) => ({
        accounts: [section(accountId, [], BETA_HARNESS_ID)],
        defaultEntry: null,
      }));

      expect(issues(failure)).toEqual([expect.stringContaining("cannot run")]);
    });

    it("a default entry that is not among the entries", async () => {
      const failure = await refusal((accountId) => ({
        accounts: [section(accountId, [entry(accountId, "current")])],
        defaultEntry: entry(accountId, "second"),
      }));

      expect(issues(failure)).toEqual([expect.stringContaining("one of the profile's entries")]);
    });

    it("no default entry on entries the caller sent", async () => {
      const failure = await refusal((accountId) => ({
        accounts: [section(accountId, [entry(accountId, "current")])],
        defaultEntry: null,
      }));

      expect(issues(failure)).toEqual([expect.stringContaining("no default entry")]);
    });
  });

  it("keeps an entry whose model is not in the catalog", async () => {
    const written = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        return yield* update(yield* readMain, {
          accounts: [
            {
              providerAccountId: accountId,
              harnessId: null,
              entries: [entry(accountId, "never-listed")],
            },
          ],
          defaultEntry: entry(accountId, "never-listed"),
        });
      }),
    );

    expect(written.accounts[0]?.entries[0]).toMatchObject({
      model: "never-listed",
      name: "never-listed",
      problem: { reason: "model-left-catalog" },
    });
  });

  describe("a section sent without entries", () => {
    it("gets its Default Selection when the catalog has been read", async () => {
      const outcome = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          const written = yield* update(yield* readMain, {
            accounts: [{ providerAccountId: accountId, harnessId: null }],
          });
          return { accountId, written };
        }),
      );

      const [section] = outcome.written.accounts;
      expect(section?.selectionPending).toBe(false);
      // The legacy model is not selected, and the catalog's default becomes the profile's.
      expect(section?.entries.map((one) => one.model)).toEqual(["current", "second"]);
      expect(outcome.written.defaultEntry).toEqual(entry(outcome.accountId, "current"));
    });

    it("is refused, naming the models, when the harness is known not to list some of them", async () => {
      const failure = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          const runner = yield* addRunner("laptop");
          yield* addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
            harnessVersion: "1.2.3",
            usage: null,
            auth: { status: "ok" },
            models: [SECOND],
          });
          return yield* Effect.flip(
            update(yield* readMain, {
              accounts: [{ providerAccountId: accountId, harnessId: null }],
            }),
          );
        }),
      );

      expect(failure).toMatchObject({
        error: {
          code: "validation",
          details: {
            issues: [
              {
                path: ["accounts", "0", "entries"],
                message: expect.stringMatching(
                  /does not list current .*Send the entries/,
                ) as unknown,
              },
            ],
          },
        },
      });
    });

    it("keeps every selected model when it lands with the first catalog read, and marks the ones the harness lacks", async () => {
      const after = await runWithProfiles(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: KEY_KIND, label: "work" });
          yield* storeCredential(account.id, "apiKey");
          yield* addRunner("laptop");
          const runner = yield* addRunner("desk");
          yield* addSnapshot(account.id, ALPHA_HARNESS_ID, runner, {
            harnessVersion: "1.2.3",
            usage: null,
            auth: { status: "ok" },
            models: [SECOND],
          });
          yield* update(yield* readMain, {
            accounts: [{ providerAccountId: account.id, harnessId: null }],
          });
          const sql = yield* SqlClient.SqlClient;
          const membership = yield* ModelProfileMembership;
          yield* withTransaction(
            sql,
            membership.fillPendingSelections(account.id, {
              models: ["current", "second"],
              defaultModel: "current",
            }),
          );
          return yield* readMain;
        }),
      );

      expect(after.accounts[0]?.entries.map((one) => [one.model, one.problem?.reason])).toEqual([
        ["current", "harness-lacks-model"],
        ["second", undefined],
      ]);
    });

    it("waits for the first catalog read, and is filled when it lands", async () => {
      const outcome = await runWithProfiles(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: KEY_KIND, label: "work" });
          const written = yield* update(yield* readMain, {
            accounts: [{ providerAccountId: account.id, harnessId: null }],
          });
          const sql = yield* SqlClient.SqlClient;
          const membership = yield* ModelProfileMembership;
          // The port runs in the caller's transaction, as a catalog read does.
          const fill = (models: ReadonlyArray<string>, defaultModel: string | null) =>
            withTransaction(
              sql,
              membership.fillPendingSelections(account.id, { models, defaultModel }),
            );
          const filled = yield* fill(["second", "current"], "current");
          const refilled = yield* fill(["other"], null);
          return { account, written, filled, refilled, after: yield* readMain };
        }),
      );

      expect(outcome.written.accounts[0]).toMatchObject({ selectionPending: true, entries: [] });
      expect(outcome.written.defaultEntry).toBeNull();
      expect(outcome.filled).toBe(true);
      expect(outcome.after.revision).toBe(outcome.written.revision + 1);
      expect(outcome.after.accounts[0]?.selectionPending).toBe(false);
      expect(outcome.after.accounts[0]?.entries.map((one) => one.model)).toEqual([
        "second",
        "current",
      ]);
      expect(outcome.after.defaultEntry).toEqual(entry(outcome.account.id, "current"));
      // Once filled, a section is not filled again.
      expect(outcome.refilled).toBe(false);
    });

    it("stays pending when the caller sends it again before the catalog lands", async () => {
      const after = await runWithProfiles(
        Effect.gen(function* () {
          const account = yield* addAccount({ kind: KEY_KIND, label: "work" });
          const pending = yield* update(yield* readMain, {
            accounts: [{ providerAccountId: account.id, harnessId: null }],
          });
          return yield* update(pending, {
            accounts: [{ providerAccountId: account.id, harnessId: null }],
          });
        }),
      );

      expect(after.accounts[0]?.selectionPending).toBe(true);
    });
  });
});

describe("a deleted account", () => {
  it("leaves every profile, and a default entry of it moves to the first remaining entry", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const first = yield* addReadyKeyAccount("work");
        const second = yield* addReadyKeyAccount("home");
        yield* update(yield* readMain, {
          accounts: [
            { providerAccountId: first, harnessId: null, entries: [entry(first, "current")] },
            {
              providerAccountId: second,
              harnessId: null,
              entries: [entry(second, "second"), entry(second, "current")],
            },
          ],
          defaultEntry: entry(first, "current"),
          dismissedNewModels: [{ providerAccountId: first, model: "old" }],
        });
        const before = yield* readMain;
        const accounts = yield* ProviderAccountService;
        yield* accounts.delete(first);
        return { before, after: yield* readMain, second };
      }),
    );

    expect(outcome.after.revision).toBe(outcome.before.revision + 1);
    expect(outcome.after.accounts.map((section) => section.providerAccountId)).toEqual([
      outcome.second,
    ]);
    expect(outcome.after.defaultEntry).toEqual(entry(outcome.second, "second"));
    expect(outcome.after.dismissedNewModels).toEqual([]);
  });

  it("leaves no default entry when no entry remains", async () => {
    const after = await runWithProfiles(
      Effect.gen(function* () {
        const only = yield* addReadyKeyAccount("work");
        yield* update(yield* readMain, {
          accounts: [
            { providerAccountId: only, harnessId: null, entries: [entry(only, "current")] },
          ],
          defaultEntry: entry(only, "current"),
        });
        const accounts = yield* ProviderAccountService;
        yield* accounts.delete(only);
        return yield* readMain;
      }),
    );

    expect(after.accounts).toEqual([]);
    expect(after.defaultEntry).toBeNull();
  });
});

describe("resolving entries", () => {
  /** Puts one entry of the account in Main, as its only entry and default. */
  const putEntry = (accountId: string, model: string, harnessId: string | null = null) =>
    Effect.flatMap(readMain, (main) =>
      update(main, {
        accounts: [
          {
            providerAccountId: accountId,
            harnessId: null,
            entries: [entry(accountId, model, harnessId)],
          },
        ],
        defaultEntry: entry(accountId, model, harnessId),
      }),
    ).pipe(Effect.map((profile) => profile.accounts[0]!.entries[0]!));

  it("resolves a key account on a connected runner: harness, name, options and no problem", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
          harnessVersion: "1.2.3",
          usage: null,
          auth: { status: "ok" },
          models: [
            buildModel("current", {
              options: [
                {
                  id: "effort",
                  label: "Effort",
                  kind: "select",
                  choices: [{ value: "high", label: "High" }],
                  default: "high",
                },
              ],
            }),
          ],
        });
        return yield* putEntry(accountId, "current");
      }),
    );

    expect(resolved).toMatchObject({
      resolvedHarnessId: ALPHA_HARNESS_ID,
      name: "Model current",
      imageInput: null,
      problem: null,
    });
    expect(resolved.options.map((option) => option.id)).toEqual(["effort"]);
  });

  it("takes the harness from the entry, else the section, else the account", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        // The account's own default is the harness that runs nothing, so only
        // an entry or a section that names alpha resolves to alpha.
        const account = yield* addAccount({
          kind: KEY_KIND,
          label: "work",
          defaultHarnessId: BETA_HARNESS_ID,
        });
        const accountId = account.id;
        const write = (sectionHarnessId: string | null, entryHarnessId: string | null) =>
          Effect.flatMap(readMain, (main) =>
            update(main, {
              accounts: [
                {
                  providerAccountId: accountId,
                  harnessId: sectionHarnessId,
                  entries: [entry(accountId, "current", entryHarnessId)],
                },
              ],
              defaultEntry: entry(accountId, "current", entryHarnessId),
            }),
          ).pipe(Effect.map((profile) => profile.accounts[0]!.entries[0]!.resolvedHarnessId));
        return [
          yield* write(null, null),
          yield* write(ALPHA_HARNESS_ID, null),
          yield* write(null, ALPHA_HARNESS_ID),
        ];
      }),
    );

    expect(resolved).toEqual([BETA_HARNESS_ID, ALPHA_HARNESS_ID, ALPHA_HARNESS_ID]);
  });

  it("reports a per-machine account that is not signed in, naming the machine", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: MACHINE_KIND, label: "home" });
        yield* storeCatalog(account.id, [CURRENT]);
        yield* addRunner("laptop");
        return yield* putEntry(account.id, "current");
      }),
    );

    expect(resolved.problem).toEqual({
      reason: "not-signed-in",
      message: expect.stringMatching(/Acme · home.*laptop/) as unknown,
    });
  });

  it("clears the problem once the account is signed in on a connected runner", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: MACHINE_KIND, label: "home" });
        yield* storeCatalog(account.id, [CURRENT]);
        const laptop = yield* addRunner("laptop");
        yield* addRunner("desk");
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, laptop, {
          harnessVersion: "1.2.3",
          usage: null,
          auth: { status: "ok", identity: "me@example.com" },
          models: [CURRENT],
        });
        return yield* putEntry(account.id, "current");
      }),
    );

    expect(resolved.problem).toBeNull();
  });

  it("reports a key account without a key", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND, label: "work" });
        yield* storeCatalog(account.id, [CURRENT]);
        yield* addRunner("laptop");
        return yield* putEntry(account.id, "current");
      }),
    );

    expect(resolved.problem).toEqual({
      reason: "credential-missing",
      message: expect.stringContaining("Add one") as unknown,
    });
  });

  it("reports a harness that is not installed on the connected runner", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* addRunner("laptop", { binaryPresent: false });
        return yield* putEntry(accountId, "current");
      }),
    );

    expect(resolved.problem).toMatchObject({ reason: "harness-missing" });
  });

  it("reports a model that left the account's catalog", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work", [SECOND]);
        yield* addRunner("laptop");
        return yield* putEntry(accountId, "current");
      }),
    );

    expect(resolved.problem).toEqual({
      reason: "model-left-catalog",
      message: expect.stringMatching(/^.* no longer lists current\.$/) as unknown,
    });
    expect(resolved.name).toBe("current");
  });

  it("names a model that left the catalog by its last probe when a probe still lists it", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work", [SECOND]);
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
          harnessVersion: "1.2.3",
          usage: null,
          auth: { status: "ok" },
          models: [CURRENT],
        });
        return yield* putEntry(accountId, "current");
      }),
    );

    expect(resolved.problem).toMatchObject({ reason: "model-left-catalog" });
    expect(resolved.name).toBe("Model current");
  });

  it("says nothing about the model while the catalog has never been read", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const account = yield* addAccount({ kind: KEY_KIND, label: "work" });
        yield* storeCredential(account.id, "apiKey");
        yield* addRunner("laptop");
        return yield* putEntry(account.id, "current");
      }),
    );

    expect(resolved.problem).toBeNull();
  });

  it("reports a harness that lists its own models and does not list this one", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        const runner = yield* addRunner("laptop");
        // The entry is put in before the probe: a write adding it afterwards is refused.
        yield* putEntry(accountId, "current");
        yield* addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
          harnessVersion: "1.2.3",
          usage: null,
          auth: { status: "ok" },
          models: [SECOND],
        });
        return (yield* readMain).accounts[0]!.entries[0]!;
      }),
    );

    expect(resolved.problem).toEqual({
      reason: "harness-lacks-model",
      message: expect.stringContaining("current") as unknown,
    });
  });

  it("does not take a missing probe as proof that the harness lacks the model", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* addRunner("laptop");
        return yield* putEntry(accountId, "current");
      }),
    );

    expect(resolved.problem).toBeNull();
  });

  it("reports a harness the account's kind may not use as not allowed, not as missing", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        // The account follows beta, which Acme's key kind lists but which cannot run Acme.
        const account = yield* addAccount({ kind: KEY_KIND, defaultHarnessId: BETA_HARNESS_ID });
        yield* addRunner("laptop");
        return yield* putEntry(account.id, "current");
      }),
    );

    expect(resolved.problem).toMatchObject({
      reason: "harness-not-allowed",
      message: expect.stringContaining("cannot run") as unknown,
    });
  });

  it("reports no runner when none is connected", async () => {
    const resolved = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        return yield* putEntry(accountId, "current");
      }),
    );

    expect(resolved.problem).toMatchObject({ reason: "no-runner" });
  });
});

describe("reading the starting entry", () => {
  /** Writes one entry of a new account to Main as its default, and reads the starting entry. */
  const readStartingEntryOf = (options: {
    readonly defaultHarnessId?: string;
    readonly sectionHarnessId: string | null;
    readonly entryHarnessId: string | null;
  }) =>
    Effect.gen(function* () {
      const account = yield* addAccount({
        kind: KEY_KIND,
        label: "work",
        ...(options.defaultHarnessId === undefined
          ? {}
          : { defaultHarnessId: options.defaultHarnessId }),
      });
      const main = yield* readMain;
      const chosen = entry(account.id, "current", options.entryHarnessId);
      yield* update(main, {
        accounts: [
          { providerAccountId: account.id, harnessId: options.sectionHarnessId, entries: [chosen] },
        ],
        defaultEntry: chosen,
      });
      const repository = yield* modelProfileRepository;
      const starting = yield* repository.readStartingEntry(main.id);
      return { accountId: account.id, starting };
    });

  it("starts on the harness the entry names", async () => {
    const { accountId, starting } = await runWithProfiles(
      readStartingEntryOf({ sectionHarnessId: null, entryHarnessId: ALPHA_HARNESS_ID }),
    );

    expect(starting).toEqual(
      Option.some({ providerAccountId: accountId, harnessId: ALPHA_HARNESS_ID, model: "current" }),
    );
  });

  it("starts on the harness the section names when the entry names none", async () => {
    const { accountId, starting } = await runWithProfiles(
      readStartingEntryOf({ sectionHarnessId: ALPHA_HARNESS_ID, entryHarnessId: null }),
    );

    expect(starting).toEqual(
      Option.some({ providerAccountId: accountId, harnessId: ALPHA_HARNESS_ID, model: "current" }),
    );
  });

  it("leaves the harness undefined, the account's default, when neither names one", async () => {
    const { accountId, starting } = await runWithProfiles(
      readStartingEntryOf({
        defaultHarnessId: BETA_HARNESS_ID,
        sectionHarnessId: null,
        entryHarnessId: null,
      }),
    );

    expect(starting).toEqual(
      Option.some({ providerAccountId: accountId, harnessId: undefined, model: "current" }),
    );
  });

  it("returns none for a profile without a default entry", async () => {
    const starting = await runWithProfiles(
      Effect.gen(function* () {
        const main = yield* readMain;
        yield* update(main, { accounts: [], defaultEntry: null });
        const repository = yield* modelProfileRepository;
        return yield* repository.readStartingEntry(main.id);
      }),
    );

    expect(starting).toEqual(Option.none());
  });

  it("returns none for a profile that does not exist", async () => {
    const starting = await runWithProfiles(
      Effect.flatMap(modelProfileRepository, (repository) => repository.readStartingEntry(MISSING)),
    );

    expect(starting).toEqual(Option.none());
  });
});

describe("an account's default harness", () => {
  /** Puts "current" in Main twice: following the account's default, and named in alpha. */
  const putTwoHarnessEntries = (accountId: string) =>
    Effect.flatMap(readMain, (main) =>
      update(main, {
        accounts: [
          {
            providerAccountId: accountId,
            harnessId: null,
            entries: [entry(accountId, "current"), entry(accountId, "current", ALPHA_HARNESS_ID)],
          },
        ],
        defaultEntry: entry(accountId, "current"),
      }),
    );

  it("cannot change to one that makes two entries of a section the same model in the same harness", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        yield* addRunner("laptop");
        // The account follows beta, so "current" there and "current" in alpha are two entries.
        const account = yield* addAccount({ kind: KEY_KIND, defaultHarnessId: BETA_HARNESS_ID });
        yield* putTwoHarnessEntries(account.id);
        const accounts = yield* ProviderAccountService;
        const failure = yield* Effect.flip(
          accounts.update({ id: account.id, defaultHarnessId: ALPHA_HARNESS_ID }),
        );
        return { failure, account: yield* accounts.read(account.id) };
      }),
    );

    expect(outcome.failure).toMatchObject({
      error: {
        code: "validation",
        details: {
          issues: [
            {
              path: ["defaultHarnessId"],
              message: expect.stringContaining(
                '"Main" holds current in Harness beta and in Harness alpha',
              ) as unknown,
            },
          ],
        },
      },
    });
    expect(outcome.account.defaultHarnessId).toBe(BETA_HARNESS_ID);
  });

  it("changes when no section would list a model twice", async () => {
    const account = await runWithProfiles(
      Effect.gen(function* () {
        yield* addRunner("laptop");
        const added = yield* addAccount({ kind: KEY_KIND, defaultHarnessId: BETA_HARNESS_ID });
        yield* Effect.flatMap(readMain, (main) =>
          update(main, {
            accounts: [
              {
                providerAccountId: added.id,
                harnessId: null,
                entries: [entry(added.id, "current")],
              },
            ],
            defaultEntry: entry(added.id, "current"),
          }),
        );
        const accounts = yield* ProviderAccountService;
        return yield* accounts.update({ id: added.id, defaultHarnessId: ALPHA_HARNESS_ID });
      }),
    );

    expect(account.defaultHarnessId).toBe(ALPHA_HARNESS_ID);
  });
});

describe("reading while an account is deleted", () => {
  it("never fails, and shows the account's entries entirely or not at all", async () => {
    const outcomes = await runWithProfiles(
      Effect.gen(function* () {
        const results: Array<{ sections: number; entries: number }> = [];
        for (let round = 0; round < 10; round += 1) {
          const accountId = yield* addReadyKeyAccount(`work ${String(round)}`);
          yield* update(yield* readMain, {
            accounts: [
              {
                providerAccountId: accountId,
                harnessId: null,
                entries: [entry(accountId, "current")],
              },
            ],
            defaultEntry: entry(accountId, "current"),
          });
          const accounts = yield* ProviderAccountService;
          const profiles = yield* ModelProfileService;
          const [read] = yield* Effect.all([profiles.query(), accounts.delete(accountId)], {
            concurrency: 2,
          });
          const [main] = read;
          results.push({
            sections: main!.accounts.length,
            entries: main!.accounts.flatMap((section) => section.entries).length,
          });
        }
        return results;
      }),
    );

    for (const outcome of outcomes) expect(outcome.sections).toBe(outcome.entries);
  });
});

/** Adds a project that names the profile (or none) and returns its id. */
const addProject = (name: string, modelProfileId?: string) =>
  Effect.flatMap(ProjectService, (projects) =>
    Effect.map(
      projects.create({ name, ...(modelProfileId === undefined ? {} : { modelProfileId }) }),
      (project) => project.id,
    ),
  );

const createProfile = (name: string, copyFromId?: string) =>
  Effect.flatMap(ModelProfileService, (profiles) =>
    profiles.create({ name, ...(copyFromId === undefined ? {} : { copyFromId }) }),
  );

describe("modelProfile.create", () => {
  it("creates an empty profile at revision 1 and audits it", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const created = yield* createProfile("Review");
        const profiles = yield* ModelProfileService;
        return {
          created,
          listed: yield* profiles.query(),
          audit: yield* readEventsOfKind("modelProfile.created"),
        };
      }),
    );

    expect(outcome.created).toMatchObject({
      name: "Review",
      revision: 1,
      accounts: [],
      defaultEntry: null,
      dismissedNewModels: [],
    });
    expect(outcome.listed.map((profile) => profile.name)).toEqual(["Main", "Review"]);
    expect(outcome.audit).toHaveLength(1);
    expect(outcome.audit[0]).toMatchObject({
      actor: "user",
      payload: { modelProfileId: outcome.created.id, name: "Review" },
    });
  });

  it("copies the stored body as it is, and the copy is independent of the source", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        const pendingId = (yield* addAccount({ kind: KEY_KIND, label: "pending" })).id;
        const main = yield* readMain;
        const source = yield* update(main, {
          accounts: [
            {
              providerAccountId: accountId,
              harnessId: null,
              entries: [entry(accountId, "second"), entry(accountId, "current")],
            },
            // No entries: this section is still waiting for its first catalog read.
            { providerAccountId: pendingId, harnessId: null },
          ],
          defaultEntry: entry(accountId, "second"),
          dismissedNewModels: [{ providerAccountId: accountId, model: "future" }],
        });
        const copy = yield* createProfile("Copy", source.id);
        const changedCopy = yield* update(copy, { defaultEntry: entry(accountId, "current") });
        const sourceAfterCopyChange = yield* readMain;
        const changedSource = yield* update(sourceAfterCopyChange, { name: "Renamed" });
        const profiles = yield* ModelProfileService;
        const copyAfterSourceChange = yield* profiles.read(copy.id);
        return {
          source,
          copy,
          changedCopy,
          sourceAfterCopyChange,
          changedSource,
          copyAfterSourceChange,
        };
      }),
    );

    expect(outcome.copy).toMatchObject({
      name: "Copy",
      revision: 1,
      accounts: outcome.source.accounts,
      defaultEntry: outcome.source.defaultEntry,
      dismissedNewModels: outcome.source.dismissedNewModels,
    });
    expect(outcome.copy.accounts[1]?.selectionPending).toBe(true);
    expect(outcome.sourceAfterCopyChange).toEqual(outcome.source);
    expect(outcome.copyAfterSourceChange).toEqual(outcome.changedCopy);
    expect(outcome.changedSource.name).toBe("Renamed");
  });

  it("refuses a name another profile has with validation on name", async () => {
    const failure = await runWithProfiles(Effect.flip(createProfile("Main")));

    expect(failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["name"] }] } },
    });
  });

  it("refuses invalid_state at the limit, naming it, and creates nothing", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        // "Main" is already there.
        for (let n = 1; n < MAX_MODEL_PROFILES; n++) yield* createProfile(`Profile ${String(n)}`);
        const failure = yield* Effect.flip(createProfile("One too many"));
        const profiles = yield* ModelProfileService;
        const listed = yield* profiles.query();
        yield* profiles.delete(listed[1]!.id);
        return { failure, count: listed.length, again: yield* createProfile("One too many") };
      }),
    );

    expect(outcome.count).toBe(MAX_MODEL_PROFILES);
    expect(outcome.failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringMatching(/32 Model Profiles.*Delete one/) as unknown,
      },
    });
    expect(outcome.again.name).toBe("One too many");
  });

  it("fails not_found when the profile to copy does not exist, and creates nothing", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(createProfile("Copy", MISSING));
        const profiles = yield* ModelProfileService;
        return { failure, listed: yield* profiles.query() };
      }),
    );

    expect(outcome.failure).toMatchObject({ error: { code: "not_found" } });
    expect(outcome.listed.map((profile) => profile.name)).toEqual(["Main"]);
  });
});

describe("modelProfile.delete", () => {
  it("stamps the cleared projects, their events and its own event with one instant", async () => {
    // A clock that moves a millisecond on every read, so a second read in the
    // delete would show as a different instant.
    let millis = Date.UTC(2026, 9, 31, 12);
    const withTickingClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Clock.clockWith((real) =>
        // The real clock is a class instance, so a spread would drop its methods.
        Effect.provideService(
          effect,
          Clock.Clock,
          Object.assign(Object.create(real) as Clock.Clock, {
            currentTimeMillisUnsafe: () => millis++,
            currentTimeMillis: Effect.sync(() => millis++),
          }),
        ),
      );
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const doomed = yield* createProfile("Review");
        const projectId = yield* addProject("Using", doomed.id);
        yield* withTickingClock((yield* ModelProfileService).delete(doomed.id));
        const sql = yield* SqlClient.SqlClient;
        return {
          projectId,
          project: yield* sql<{ readonly updated_at: string }>`
            SELECT updated_at FROM projects WHERE id = ${uuidFromString(projectId)}
          `,
          cleared: yield* readEventsOfKind("project.updated"),
          deleted: yield* readEventsOfKind("modelProfile.deleted"),
        };
      }),
    );

    const [deleted] = outcome.deleted;
    const cleared = outcome.cleared.filter(
      (event) => event.payload["projectId"] === outcome.projectId,
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.receivedAt).toBe(deleted?.receivedAt);
    expect(outcome.project[0]?.updated_at).toBe(deleted?.receivedAt);
  });

  it("removes the profile and audits it", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const created = yield* createProfile("Review");
        const profiles = yield* ModelProfileService;
        const result = yield* profiles.delete(created.id);
        return {
          created,
          result,
          listed: yield* profiles.query(),
          readFailure: yield* Effect.flip(profiles.read(created.id)),
          audit: yield* readEventsOfKind("modelProfile.deleted"),
        };
      }),
    );

    expect(outcome.result).toEqual({});
    expect(outcome.listed.map((profile) => profile.name)).toEqual(["Main"]);
    expect(outcome.readFailure).toMatchObject({ error: { code: "not_found" } });
    expect(outcome.audit).toHaveLength(1);
    expect(outcome.audit[0]).toMatchObject({
      actor: "user",
      payload: { modelProfileId: outcome.created.id, name: "Review" },
    });
  });

  it("refuses the last profile with invalid_state and keeps it", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const main = yield* readMain;
        const profiles = yield* ModelProfileService;
        return {
          main,
          failure: yield* Effect.flip(profiles.delete(main.id)),
          listed: yield* profiles.query(),
        };
      }),
    );

    expect(outcome.failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: "This is your only Model Profile. Create another before you delete this one.",
      },
    });
    expect(outcome.listed).toEqual([outcome.main]);
  });

  it("fails not_found for a profile that does not exist", async () => {
    const failure = await runWithProfiles(
      Effect.flatMap(ModelProfileService, (profiles) => Effect.flip(profiles.delete(MISSING))),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it("clears the profile from every project that names it and records project.updated for each live one", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const doomed = yield* createProfile("Review");
        const kept = yield* createProfile("Other");
        const projects = yield* ProjectService;
        const usingId = yield* addProject("Using", doomed.id);
        const otherId = yield* addProject("Other user", kept.id);
        const retiredId = yield* addProject("Retired", doomed.id);
        yield* projects.delete(retiredId);
        yield* (yield* ModelProfileService).delete(doomed.id);
        const sql = yield* SqlClient.SqlClient;
        return {
          doomed,
          kept,
          usingId,
          using: yield* projects.read(usingId),
          other: yield* projects.read(otherId),
          retiredRows: yield* sql<{ readonly model_profile_id: Uint8Array | null }>`
            SELECT model_profile_id FROM projects WHERE id = ${uuidFromString(retiredId)}
          `,
          updates: yield* readEventsOfKind("project.updated"),
        };
      }),
    );

    expect("modelProfileId" in outcome.using).toBe(false);
    expect(outcome.other.modelProfileId).toBe(outcome.kept.id);
    expect(outcome.retiredRows).toEqual([{ model_profile_id: null }]);
    const clearing = outcome.updates.filter((event) =>
      JSON.stringify(event.payload).includes(outcome.doomed.id),
    );
    expect(clearing).toHaveLength(1);
    expect(clearing[0]).toMatchObject({
      actor: "user",
      payload: {
        projectId: outcome.usingId,
        changes: { modelProfileId: { old: outcome.doomed.id, new: null } },
      },
    });
  });
});

describe("announcing new models", () => {
  const FIRST_READ = "2026-10-31T09:00:00.000Z";
  const SECOND_READ = "2026-10-31T13:00:00.000Z";
  const THIRD_READ = "2026-10-31T17:00:00.000Z";

  /** The new models of the first section of every profile, by profile name. */
  const readNewModels = Effect.gen(function* () {
    const profiles = yield* ModelProfileService;
    return Object.fromEntries(
      (yield* profiles.query()).map((profile) => [
        profile.name,
        profile.accounts[0]?.newModels.map((one) => one.model),
      ]),
    );
  });

  /**
   * Gives Main a section of the account that holds `models`, and makes the
   * profile "Review" a copy of it. The account's first catalog read is
   * `FIRST_READ`, with `models`.
   */
  const holdInTwoProfiles = (
    accountId: string,
    models: ReadonlyArray<string> = ["current", "second"],
  ) =>
    Effect.gen(function* () {
      const main = yield* update(yield* readMain, {
        accounts: [
          {
            providerAccountId: accountId,
            harnessId: null,
            entries: models.map((model) => entry(accountId, model)),
          },
        ],
        defaultEntry: models[0] === undefined ? null : entry(accountId, models[0]),
      });
      yield* createProfile("Review", main.id);
    });

  /** Reads the profile with the name. */
  const readNamed = (name: string) =>
    Effect.gen(function* () {
      const profiles = yield* ModelProfileService;
      return (yield* profiles.query()).find((profile) => profile.name === name)!;
    });

  const FRESH = buildModel("fresh");

  /** The fixture plugins, with `beta/beta` also running Acme key accounts, so one model can be held in two harnesses. */
  const pluginsWhereBetaRunsAcme = (): ReadonlyArray<Plugin> => [
    ...buildAccountPlugins().slice(0, 2),
    createPluginFixture({
      id: "beta",
      definitions: [
        buildHarnessDefinition("beta", [
          {
            providerId: ACME_PROVIDER_ID,
            kinds: [
              { kind: KEY_KIND, modelArgument: "acme/{model}", credentialVariable: "ACME_API_KEY" },
            ],
            models: "all",
          },
        ]),
      ],
    }).plugin,
  ];

  it("announces a model that arrived after the first read once in every profile that holds the account", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* holdInTwoProfiles(accountId);
        const before = yield* readNewModels;
        yield* storeCatalog(accountId, [CURRENT, SECOND, OLD, FRESH], SECOND_READ);
        const profiles = yield* ModelProfileService;
        return { before, after: yield* profiles.query() };
      }),
    );

    expect(outcome.before).toEqual({ Main: [], Review: [] });
    expect(outcome.after.map((profile) => profile.name)).toEqual(["Main", "Review"]);
    for (const profile of outcome.after) {
      expect(profile.accounts[0]?.newModels).toEqual([
        { model: "fresh", name: "Model fresh", firstSeenAt: SECOND_READ },
      ]);
    }
  });

  it("never announces the models of the first read, nor a model that arrived legacy", async () => {
    const after = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        // Main holds only "current": "second" is in the Default Selection of the first read, and not held.
        yield* holdInTwoProfiles(accountId, ["current"]);
        yield* storeCatalog(
          accountId,
          [CURRENT, SECOND, OLD, buildModel("fresh-legacy", { isLegacy: true })],
          SECOND_READ,
        );
        return yield* readNewModels;
      }),
    );

    expect(after).toEqual({ Main: [], Review: [] });
  });

  it("announces a model that arrived legacy once it stops being legacy", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* holdInTwoProfiles(accountId);
        yield* storeCatalog(
          accountId,
          [CURRENT, SECOND, buildModel("promoted", { isLegacy: true })],
          SECOND_READ,
        );
        const whileLegacy = yield* readNewModels;
        yield* storeCatalog(accountId, [CURRENT, SECOND, buildModel("promoted")], THIRD_READ);
        const profiles = yield* ModelProfileService;
        return { whileLegacy, after: (yield* profiles.query())[0]! };
      }),
    );

    expect(outcome.whileLegacy).toEqual({ Main: [], Review: [] });
    // It is announced with the time it first appeared, not the time it was promoted.
    expect(outcome.after.accounts[0]?.newModels).toEqual([
      { model: "promoted", name: "Model promoted", firstSeenAt: SECOND_READ },
    ]);
  });

  it("announces the models of the first read that lists any, when an earlier successful read listed none", async () => {
    const after = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work", []);
        yield* holdInTwoProfiles(accountId, []);
        yield* storeCatalog(accountId, [CURRENT, SECOND], SECOND_READ);
        return yield* readNewModels;
      }),
    );

    expect(after).toEqual({ Main: ["current", "second"], Review: ["current", "second"] });
  });

  it("lists the new models in the order of the Default Selection", async () => {
    const after = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* holdInTwoProfiles(accountId);
        yield* storeCatalog(
          accountId,
          [buildModel("zeta"), CURRENT, SECOND, buildModel("alpha")],
          SECOND_READ,
        );
        return yield* readNewModels;
      }),
    );

    expect(after).toEqual({ Main: ["zeta", "alpha"], Review: ["zeta", "alpha"] });
  });

  it("stops announcing in the profile that adds the model, in any harness, and only there", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* holdInTwoProfiles(accountId);
        yield* storeCatalog(accountId, [CURRENT, SECOND, OLD, FRESH], SECOND_READ);
        const main = yield* readNamed("Main");
        const added = yield* update(main, {
          accounts: [
            {
              providerAccountId: accountId,
              harnessId: null,
              entries: [
                entry(accountId, "current"),
                entry(accountId, "second"),
                // Held in another harness than the one the section runs in.
                entry(accountId, "fresh", BETA_HARNESS_ID),
              ],
            },
          ],
        });
        return { added, reread: yield* readNewModels };
      }),
      pluginsWhereBetaRunsAcme(),
    );

    expect(outcome.added.accounts[0]?.newModels).toEqual([]);
    expect(outcome.reread).toEqual({ Main: [], Review: ["fresh"] });
  });

  it("stops announcing in the profile that declines the model, only there, and still after the next read", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* holdInTwoProfiles(accountId);
        yield* storeCatalog(accountId, [CURRENT, SECOND, OLD, FRESH], SECOND_READ);
        const declined = yield* update(yield* readNamed("Main"), {
          dismissedNewModels: [{ providerAccountId: accountId, model: "fresh" }],
        });
        const afterDismissal = yield* readNewModels;
        // The next refresh finds the same models.
        yield* storeCatalog(accountId, [CURRENT, SECOND, OLD, FRESH], THIRD_READ);
        return { declined, afterDismissal, afterRefresh: yield* readNewModels };
      }),
    );

    expect(outcome.declined.accounts[0]?.newModels).toEqual([]);
    expect(outcome.afterDismissal).toEqual({ Main: [], Review: ["fresh"] });
    expect(outcome.afterRefresh).toEqual({ Main: [], Review: ["fresh"] });
  });

  it("announces nothing for a section that waits for the account's first catalog read", async () => {
    const after = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = (yield* addAccount({ kind: KEY_KIND, label: "work" })).id;
        yield* update(yield* readMain, {
          accounts: [{ providerAccountId: accountId, harnessId: null }],
        });
        // The stored read does not fill the section, as the daemon's read does.
        yield* storeCatalog(accountId, [CURRENT, SECOND], FIRST_READ);
        yield* storeCatalog(accountId, [CURRENT, SECOND, FRESH], SECOND_READ);
        return (yield* readMain).accounts[0];
      }),
    );

    expect(after).toMatchObject({ selectionPending: true, entries: [], newModels: [] });
  });

  it("announces nothing for a provider whose Default Selection is none", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const acme = yield* addReadyKeyAccount("work");
        const metered = yield* addAccount({
          providerId: METERED_PROVIDER_ID,
          kind: METERED_KEY_KIND,
        });
        yield* storeCatalog(metered.id, [CURRENT], FIRST_READ);
        yield* update(yield* readMain, {
          accounts: [
            {
              providerAccountId: acme,
              harnessId: null,
              entries: [entry(acme, "current"), entry(acme, "second")],
            },
            { providerAccountId: metered.id, harnessId: null, entries: [] },
          ],
          defaultEntry: entry(acme, "current"),
        });
        yield* storeCatalog(acme, [CURRENT, SECOND, FRESH], SECOND_READ);
        yield* storeCatalog(metered.id, [CURRENT, FRESH], SECOND_READ);
        return (yield* readMain).accounts.map((section) =>
          section.newModels.map((one) => one.model),
        );
      }),
      [...buildAccountPlugins(), buildMeteredPlugin({ ...METERED, defaultSelection: "none" })],
    );

    // The account of a provider with a Default Selection announces; the other one does not.
    expect(outcome).toEqual([["fresh"], []]);
  });

  it("waits to announce a model the section's harness is known not to list, and announces it once the harness lists it", async () => {
    const outcome = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        const runner = yield* addRunner("laptop");
        const probeListing = (...models: ReadonlyArray<ReturnType<typeof buildModel>>) =>
          addSnapshot(accountId, ALPHA_HARNESS_ID, runner, {
            harnessVersion: "1.2.3",
            usage: null,
            auth: { status: "ok" },
            models,
          });
        yield* probeListing(CURRENT, SECOND);
        yield* holdInTwoProfiles(accountId);
        yield* storeCatalog(accountId, [CURRENT, SECOND, FRESH], SECOND_READ);
        const whileUnlisted = yield* readNewModels;
        yield* probeListing(CURRENT, SECOND, FRESH);
        return { whileUnlisted, whenListed: yield* readNewModels };
      }),
    );

    expect(outcome.whileUnlisted).toEqual({ Main: [], Review: [] });
    expect(outcome.whenListed).toEqual({ Main: ["fresh"], Review: ["fresh"] });
  });

  it("stores only the dismissals that can still matter", async () => {
    const written = await runWithProfiles(
      Effect.gen(function* () {
        const accountId = yield* addReadyKeyAccount("work");
        yield* holdInTwoProfiles(accountId);
        yield* storeCatalog(accountId, [CURRENT, SECOND, OLD, FRESH], SECOND_READ);
        const dismiss = (model: string) => ({ providerAccountId: accountId, model });
        return yield* update(yield* readMain, {
          dismissedNewModels: [
            // In the first read, so it was never new.
            dismiss("second"),
            dismiss("old"),
            // Arrived after the first read.
            dismiss("fresh"),
            // Not in the catalog yet, so it may still arrive.
            dismiss("future"),
          ],
        });
      }),
    );

    expect(written.dismissedNewModels.map((one) => one.model)).toEqual(["fresh", "future"]);
  });

  describe("the bound on stored dismissals", () => {
    const dismissals = (accountId: string, prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        providerAccountId: accountId,
        model: `${prefix}-${String(index)}`,
      }));

    it("counts what is stored, so a request may carry dismissals that are dropped on top of a full list", async () => {
      const written = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          return yield* update(yield* readMain, {
            accounts: [{ providerAccountId: accountId, harnessId: null, entries: [] }],
            defaultEntry: null,
            dismissedNewModels: [
              // The 1025th is a model of the first read, which could never be announced.
              ...dismissals(accountId, "future", MAX_DISMISSED_NEW_MODELS),
              { providerAccountId: accountId, model: "second" },
            ],
          });
        }),
      );

      expect(written.dismissedNewModels).toHaveLength(MAX_DISMISSED_NEW_MODELS);
    });

    it("refuses a list that keeps more than the bound, saying what to do", async () => {
      const failure = await runWithProfiles(
        Effect.gen(function* () {
          const accountId = yield* addReadyKeyAccount("work");
          return yield* Effect.flip(
            update(yield* readMain, {
              accounts: [{ providerAccountId: accountId, harnessId: null, entries: [] }],
              defaultEntry: null,
              dismissedNewModels: dismissals(accountId, "future", MAX_DISMISSED_NEW_MODELS + 1),
            }),
          );
        }),
      );

      expect(failure).toMatchObject({
        error: {
          code: "validation",
          details: {
            issues: [
              {
                path: ["dismissedNewModels"],
                message:
                  "This profile has dismissed 1025 new models, the most it keeps (1024). Take some out of its dismissed list with `hercule model-profile update`.",
              },
            ],
          },
        },
      });
    });
  });

  it("stores no dismissal for a provider whose Default Selection is none", async () => {
    const written = await runWithProfiles(
      Effect.gen(function* () {
        const metered = yield* addAccount({
          providerId: METERED_PROVIDER_ID,
          kind: METERED_KEY_KIND,
        });
        yield* storeCatalog(metered.id, [CURRENT], FIRST_READ);
        yield* storeCatalog(metered.id, [CURRENT, FRESH], SECOND_READ);
        return yield* update(yield* readMain, {
          accounts: [{ providerAccountId: metered.id, harnessId: null, entries: [] }],
          dismissedNewModels: [
            { providerAccountId: metered.id, model: "fresh" },
            { providerAccountId: metered.id, model: "future" },
          ],
        });
      }),
      [...buildAccountPlugins(), buildMeteredPlugin({ ...METERED, defaultSelection: "none" })],
    );

    expect(written.dismissedNewModels).toEqual([]);
  });
});
