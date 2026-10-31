import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../db";
import type { AuditLog } from "../events";
import { readEventsOfKind } from "../events/testing";
import { PluginHost, registry } from "../plugins";
import { asUser, buildPluginStack } from "../plugins/testing";
import { providerAccountRepository } from "./repository";
import { seedProviderAccounts } from "./seed";

/** Runs against the plugins this build ships, as a real boot does. */
const run = <A, E>(body: Effect.Effect<A, E, PluginHost | SqlClient.SqlClient | AuditLog>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(registry));
      return yield* body;
    }).pipe(Effect.provide(buildPluginStack()), asUser) as Effect.Effect<A, E, never>,
  );

const markSetupComplete = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  withTransaction(
    sql,
    sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
        VALUES (1, NULL, '2026-10-31T00:00:00.000Z')`,
  ),
);

const listAccounts = Effect.flatMap(providerAccountRepository, (accounts) => accounts.list());

describe("seedProviderAccounts", () => {
  it("creates the three defaults on a fresh install, oldest first, audited by the system", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* seedProviderAccounts;
        return {
          accounts: yield* listAccounts,
          audit: yield* readEventsOfKind("providerAccount.created"),
        };
      }),
    );

    expect(
      outcome.accounts.map((account) => [
        account.providerId,
        account.kind,
        account.defaultHarnessId,
      ]),
    ).toEqual([
      ["anthropic/anthropic", "subscription-per-machine", "claude-code/claude-code"],
      ["openai/openai", "subscription-per-machine", "codex/codex"],
      ["zai/zai", "api-key", "pi/pi"],
    ]);
    expect(outcome.accounts.every((account) => account.label === null)).toBe(true);
    expect(outcome.audit).toHaveLength(3);
    expect(outcome.audit.every((entry) => entry.actor === "system")).toBe(true);
  });

  it("changes nothing on a second boot", async () => {
    const accounts = await run(
      Effect.gen(function* () {
        yield* seedProviderAccounts;
        const before = yield* listAccounts;
        yield* seedProviderAccounts;
        return { before, after: yield* listAccounts };
      }),
    );

    expect(accounts.after).toEqual(accounts.before);
  });

  it("creates nothing once setup is complete, so a deleted account stays deleted", async () => {
    const accounts = await run(
      Effect.gen(function* () {
        yield* markSetupComplete;
        yield* seedProviderAccounts;
        return yield* listAccounts;
      }),
    );

    expect(accounts).toEqual([]);
  });

  it("creates nothing when an account already exists, as after a migration", async () => {
    const accounts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* providerAccountRepository;
        yield* withTransaction(
          sql,
          repository.insert({
            providerId: "zai/zai",
            kind: "api-key",
            label: null,
            defaultHarnessId: "pi/pi",
            at: "2026-10-31T00:00:00.000Z",
          }),
        );
        yield* seedProviderAccounts;
        return yield* listAccounts;
      }),
    );

    expect(accounts.map((account) => account.providerId)).toEqual(["zai/zai"]);
  });
});
