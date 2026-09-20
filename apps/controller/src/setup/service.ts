/**
 * First run, finished: `setup.read` and `setup.complete`.
 *
 * Until setup completes these two operations are the only ones the controller
 * answers; everything else is 401, which the gate in `../http` enforces. The
 * boot minted a single-use token and wrote it to `<home>/setup-url`; completing
 * setup consumes it.
 *
 * The write is one transaction: the completion stamp, the token's removal, the
 * user, the timezone and the login token the caller is handed back go in
 * together or not at all, so a controller that dies mid-setup comes back with
 * the setup URL still valid rather than with a user nobody can log in as, or
 * with a finished setup and no way in.
 *
 * Claiming the completion stamp is also what makes the token single use.
 * Everything that decides happens inside that one transaction, so concurrent
 * calls carrying the same token produce one user rather than one each.
 *
 * Two things setup does not do here: the default assistant, which has no table
 * yet, and the onboarding steps beyond the timezone, which are the web app's.
 */
import { rmSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { invalidState, type InvalidState } from "@hercule/contract";
import { USER_ACTOR } from "../actor";
import { HerculeHome } from "../config";
import { Credentials, hashToken, mintToken } from "../credentials";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { Settings, type SettingError } from "../settings";
import { hashPassword, PasswordCost, Users } from "../users";

/** What `setup.complete` carries beyond the password. */
export interface CompleteInput {
  readonly username: string;
  readonly password: string;
  readonly timezone: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const users = yield* Users;
  const credentials = yield* Credentials;
  const settings = yield* Settings;
  const audit = yield* AuditLog;
  const paths = yield* HerculeHome;
  const cost = yield* PasswordCost;

  const row = sql<{
    readonly token_hash: string | null;
    readonly completed_at: string | null;
  }>`SELECT token_hash, completed_at FROM setup_state WHERE singleton = 1`.pipe(
    Effect.map((rows) => rows[0]),
  );

  return {
    /** Whether first run is done, so the web app knows to route to `/setup`. */
    state: (): Effect.Effect<{ readonly complete: boolean }, SqlError> =>
      Effect.map(row, (state) => ({ complete: state?.completed_at != null })),

    /**
     * Whether this is the outstanding setup token. Only its hash was stored, so
     * a copy of the database hands nobody a working token.
     */
    matchesToken: (token: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        row,
        (state) => state?.completed_at == null && state?.token_hash === hashToken(token),
      ),

    /**
     * Creates the user, finishes onboarding and returns a bearer token: the
     * caller is logged in when this returns. The setup
     * token is verified by the transport gate before this runs.
     */
    complete: (
      input: CompleteInput,
    ): Effect.Effect<{ readonly token: string }, InvalidState | SettingError | SqlError> =>
      Effect.gen(function* () {
        // Hashing a password takes tens of milliseconds and SQLite has one
        // writer, so it happens before the transaction opens, never inside it.
        const passwordHash = yield* hashPassword(input.password, cost);
        const token = mintToken();

        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            // The claim is the guard: whoever's UPDATE changes the row finishes
            // setup and everyone else is told it is already done. Reading the
            // flag first and writing afterwards would let two callers holding
            // the same token both pass.
            yield* sql`
              UPDATE setup_state SET completed_at = ${at}, token_hash = NULL
              WHERE singleton = 1 AND completed_at IS NULL
            `;
            const changed = yield* sql<{ readonly rows: number }>`SELECT changes() AS rows`;
            if ((changed[0]?.rows ?? 0) === 0) {
              return yield* Effect.fail(invalidState("Hercule is already set up."));
            }

            const user = yield* users.create(input.username, passwordHash);
            yield* settings.setForUser(user.id, "timezone", input.timezone);
            yield* audit.append({
              kind: "setup.completed",
              actor: USER_ACTOR,
              payload: { username: input.username },
            });
            // Inside the transaction because the caller is logged in when this
            // returns: a token that cannot be stored is a setup that did not
            // happen, not a finished setup with nothing to answer with.
            yield* credentials.issueLoginToken(user.id, hashToken(token));
          }),
        );

        // The file exists only while setup is incomplete.
        // Setup is done either way, so a file that will not go is a line in the
        // log rather than a failed response.
        yield* Effect.try(() => rmSync(paths.setupUrlFile, { force: true })).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(`Cannot remove ${paths.setupUrlFile}`, cause),
          ),
          Effect.ignore,
        );

        return { token };
      }),
  };
});

/** The setup service. */
export class Setup extends Context.Service<Setup, Effect.Success<typeof make>>()(
  "hercule/controller/setup/Setup",
) {}

export const SetupLayer: Layer.Layer<
  Setup,
  never,
  SqlClient.SqlClient | Users | Credentials | Settings | HerculeHome | AuditLog
> = Layer.effect(Setup)(make);
