/**
 * Finds what still points at a Provider Account, which is what makes deleting
 * it unsafe (spec 06 section 15.7).
 *
 * The Text Generation model and the users' Thread defaults are read through
 * the settings domain, which this domain may import. Agents (with the
 * assistants) and sessions import this domain, so it cannot import them back.
 * Their tables are read with SQL here instead, which is also what lets the
 * check run in the same transaction as the delete.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { uuidFromString } from "../db";
import { Settings } from "../settings";

/** What uses an account. Every field empty, zero or false means the account can be deleted. */
export interface ProviderAccountUses {
  /** The names of the Agents that run on the account. */
  readonly agents: ReadonlyArray<string>;
  /** The names of the assistants that run on the account. */
  readonly assistants: ReadonlyArray<string>;
  /** Whether the controller's `textGeneration.model` setting names the account. */
  readonly usedByTextGeneration: boolean;
  /** How many users have the account as their `thread.providerAccountId` default. */
  readonly threadDefaultUsers: number;
  /** How many sessions on the account are queued, starting, idle or busy. */
  readonly runningSessions: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings;

  return {
    /**
     * Returns what uses the account. The settings are compared by their
     * decoded values, not by their stored text, so spacing or escaping in the
     * text cannot hide a reference. A stored setting that cannot be decoded
     * uses nothing, because it reads as unset everywhere else too.
     */
    findUses: (providerAccountId: string): Effect.Effect<ProviderAccountUses, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(providerAccountId);
        const agentRows = yield* sql<{ readonly name: string; readonly kind: string }>`
          SELECT name, kind FROM agents WHERE provider_account_id = ${id} ORDER BY name
        `;
        const textGeneration = (yield* settings.all())["textGeneration.model"];
        const threadDefaults = yield* settings.listUserValues("thread.providerAccountId");
        const sessionRows = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM sessions
          WHERE provider_account_id = ${id}
            AND status IN ('queued', 'starting', 'idle', 'busy')
        `;
        return {
          agents: agentRows.filter((row) => row.kind === "agent").map((row) => row.name),
          assistants: agentRows.filter((row) => row.kind === "assistant").map((row) => row.name),
          usedByTextGeneration:
            typeof textGeneration === "object" &&
            textGeneration.providerAccountId === providerAccountId,
          threadDefaultUsers: threadDefaults.filter((chosen) => chosen === providerAccountId)
            .length,
          runningSessions: sessionRows[0]?.count ?? 0,
        };
      }),
  };
});

export const providerAccountUses = make;
