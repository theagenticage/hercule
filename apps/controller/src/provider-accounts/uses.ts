/**
 * Finds what still points at a Provider Account, which is what makes deleting
 * it unsafe (spec 06 section 15.7).
 *
 * These are reads of tables other domains own: agents and assistants, the
 * controller and user settings, and sessions. Those domains import this one,
 * so this one cannot import them back, and the check has to run in the same
 * transaction as the delete anyway.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { uuidFromString } from "../db";

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

/** Decodes the `textGeneration.model` setting when it names an account: `automatic` and `off` do not. */
const decodeChosenModel = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ providerAccountId: Schema.String })),
);

const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Returns what uses the account. A setting is compared by its decoded JSON
     * value, not by its text, so spacing or escaping in the stored text cannot
     * hide a reference. A stored value that is not JSON uses nothing.
     */
    findUses: (providerAccountId: string): Effect.Effect<ProviderAccountUses, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(providerAccountId);
        const agentRows = yield* sql<{ readonly name: string; readonly kind: string }>`
          SELECT name, kind FROM agents WHERE provider_account_id = ${id} ORDER BY name
        `;
        const textGeneration = yield* sql<{ readonly value: string }>`
          SELECT value FROM settings
          WHERE scope = 'controller' AND key = 'textGeneration.model'
        `;
        const threadDefaults = yield* sql<{ readonly value: string }>`
          SELECT value FROM user_settings WHERE key = 'thread.providerAccountId'
        `;
        const sessionRows = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM sessions
          WHERE provider_account_id = ${id}
            AND status IN ('queued', 'starting', 'idle', 'busy')
        `;
        return {
          agents: agentRows.filter((row) => row.kind === "agent").map((row) => row.name),
          assistants: agentRows.filter((row) => row.kind === "assistant").map((row) => row.name),
          usedByTextGeneration: textGeneration.some((row) => {
            const chosen = decodeChosenModel(row.value);
            return chosen._tag === "Some" && chosen.value.providerAccountId === providerAccountId;
          }),
          threadDefaultUsers: threadDefaults.filter((row) => {
            const chosen = decodeJsonString(row.value);
            return chosen._tag === "Some" && chosen.value === providerAccountId;
          }).length,
          runningSessions: sessionRows[0]?.count ?? 0,
        };
      }),
  };
});

export const providerAccountUses = make;
