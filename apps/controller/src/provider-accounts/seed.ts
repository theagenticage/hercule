/**
 * Creates the three Provider Accounts a fresh install starts with, so the
 * first run can offer "Sign in to Claude Code" before there is any way to add
 * an account.
 *
 * TEMPORARY: this stands in for the add-account flow, which ticket #934
 * (`providerAccount.create`) builds. That ticket deletes this file and its
 * call at boot.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { providerAccountRepository } from "./repository";

/**
 * The accounts a fresh install gets, in the order they are created: each
 * vendor's subscription signed in on each machine, and Z.ai with a key. The
 * Z.ai account starts with no key; the user sets it with
 * `providerAccount.update`.
 */
const FRESH_INSTALL_ACCOUNTS = [
  {
    providerId: "anthropic/anthropic",
    kind: "subscription-per-machine",
    defaultHarnessId: "claude-code/claude-code",
  },
  {
    providerId: "openai/openai",
    kind: "subscription-per-machine",
    defaultHarnessId: "codex/codex",
  },
  { providerId: "zai/zai", kind: "api-key", defaultHarnessId: "pi/pi" },
] as const;

/**
 * Creates the three default accounts when the controller has no Provider
 * Account at all and first-run setup is not complete. It does nothing
 * otherwise, so an account the user deleted after setup stays deleted, and an
 * install that was upgraded from the previous version keeps exactly the
 * accounts the upgrade made.
 *
 * A default is skipped when this build does not register its provider and
 * account kind, since an account of a provider nobody can run is of no use.
 * Each account is audited as `providerAccount.created`, by the system.
 */
export const seedProviderAccounts: Effect.Effect<
  void,
  SqlError,
  SqlClient.SqlClient | PluginHost | AuditLog
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* providerAccountRepository;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  // Read from the setup table directly: the setup domain depends on this one
  // (through the assistants it creates), so this one cannot import it. A
  // fresh database has no row yet, which also means setup is not complete.
  const setup = yield* sql<{ readonly completed_at: string | null }>`
    SELECT completed_at FROM setup_state WHERE singleton = 1
  `;
  if (setup[0]?.completed_at != null) return;
  if (yield* accounts.hasAny()) return;
  const providers = yield* host.providers();
  const registered = FRESH_INSTALL_ACCOUNTS.filter((account) =>
    providers.some(
      (provider) =>
        provider.id === account.providerId &&
        provider.kinds.some((kind) => kind.id === account.kind),
    ),
  );
  if (registered.length === 0) return;
  const at = yield* nowIso;
  yield* withTransaction(
    sql,
    Effect.forEach(
      registered,
      (account) =>
        Effect.gen(function* () {
          const stored = yield* accounts.insert({ ...account, label: null, at });
          yield* audit.append({
            kind: "providerAccount.created",
            actor: SYSTEM_ACTOR,
            payload: {
              providerAccountId: stored.id,
              providerId: stored.providerId,
              kind: stored.kind,
            },
            record: { topic: "provider", id: stored.id },
            at,
          });
        }),
      { discard: true },
    ),
  );
});
