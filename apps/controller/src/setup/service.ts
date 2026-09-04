/**
 * First run, finished: `setup.read` and `setup.complete` (spec 15 section 7,
 * spec 11 section 2).
 *
 * Until setup completes these two operations are the only ones the controller
 * answers; everything else is 401, which the gate in `../http` enforces. The
 * boot minted a single-use token and wrote it to `<home>/setup-url`; completing
 * setup consumes it.
 *
 * The write is one transaction: the user, the completion stamp, the token's
 * removal and the timezone go in together or not at all, so a controller that
 * dies mid-setup comes back with the setup URL still valid rather than with a
 * user nobody can log in as.
 *
 * Two things spec 15 section 7 asks of setup are not here: the default
 * assistant, which has no table yet and lands with the assistant ticket, and
 * the onboarding steps beyond the timezone, which are the web app's.
 */
import { rmSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { invalidState, type InvalidState } from "@hydra/contract";
import { HydraHome } from "../config";
import { Credentials, hashToken, mintToken } from "../credentials";
import { withTransaction } from "../db";
import { Settings, type SettingError } from "../settings";
import { hashPassword, PasswordCost, Users } from "../users";

/** What `setup.complete` carries beyond the password (spec 15 section 7). */
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
  const paths = yield* HydraHome;
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
     * caller is logged in when this returns (spec 15 section 7). The setup
     * token is verified by the transport gate before this runs.
     */
    complete: (
      input: CompleteInput,
    ): Effect.Effect<{ readonly token: string }, InvalidState | SettingError | SqlError> =>
      Effect.gen(function* () {
        const state = yield* row;
        if (state?.completed_at != null) {
          return yield* Effect.fail(invalidState("Hydra is already set up."));
        }

        // Hashing a password takes tens of milliseconds and SQLite has one
        // writer, so it happens before the transaction opens, never inside it.
        const passwordHash = yield* hashPassword(input.password, cost);

        const user = yield* withTransaction(
          Effect.gen(function* () {
            const created = yield* users.create(input.username, passwordHash);
            const at = new Date(yield* Clock.currentTimeMillis).toISOString();
            yield* sql`
              UPDATE setup_state SET completed_at = ${at}, token_hash = NULL WHERE singleton = 1
            `;
            yield* settings.set("user", "timezone", input.timezone);
            // TODO(#57 WP5): audit setup.completed
            return created;
          }),
        );

        // The file exists only while setup is incomplete (spec 15 section 7).
        // Setup is done either way, so a file that will not go is a line in the
        // log rather than a failed response.
        yield* Effect.try(() => rmSync(paths.setupUrlFile, { force: true })).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(`Cannot remove ${paths.setupUrlFile}`, cause),
          ),
          Effect.ignore,
        );

        const token = mintToken();
        yield* credentials.issueLoginToken(user.id, hashToken(token));
        return { token };
        // The transaction runs on the client this service already holds, so the
        // method needs nothing from its caller's context.
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  };
});

/** The setup service (ADR 0031: every operation is a method on an Effect service). */
export class Setup extends Context.Service<Setup, Effect.Success<typeof make>>()(
  "hydra/controller/setup/Setup",
) {}

export const SetupLayer: Layer.Layer<
  Setup,
  never,
  SqlClient.SqlClient | Users | Credentials | Settings | HydraHome
> = Layer.effect(Setup)(make);
