/**
 * Completes first run: `setup.read` and `setup.complete`.
 *
 * Until setup completes, these two operations are the only ones the controller
 * serves; everything else returns 401, which the gate in `../http` enforces.
 * The boot created a single-use token and wrote it to `<home>/setup-url`;
 * completing setup uses it up.
 *
 * The write is one transaction. The completion timestamp, the token's removal,
 * the user, the timezone and the login token returned to the caller are
 * written together or not at all. So a controller that dies during setup
 * restarts with the setup URL still valid, rather than with a user nobody can
 * log in as, or with a finished setup and no way in.
 *
 * Setting the completion timestamp is also what makes the token single use.
 * Every check happens inside that one transaction, so concurrent calls with
 * the same token create one user rather than one each.
 *
 * The default assistant, `Hercule`, is created in that same transaction, so a
 * finished setup always has an assistant to talk to. It is created from its
 * name alone, like any other, and stamped with the new user.
 *
 * The onboarding steps beyond the timezone are the web app's, not setup's.
 */
import { rmSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Forbidden,
  Unauthenticated,
  Validation,
  createInvalidStateError,
  type InvalidState,
} from "@hercule/contract";
import { CurrentActor, USER_ACTOR } from "../actor";
import { AssistantService } from "../assistants";
import { HerculeHome } from "../config";
import { Credentials, hashToken, mintToken } from "../credentials";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import type { GrantsError } from "../permissions";
import { Settings, validateTimezone, type SettingError } from "../settings";
import { hashPassword, PasswordCost, Users } from "../users";

/** The name of the assistant setup creates. */
const DEFAULT_ASSISTANT_NAME = "Hercule";

/** The input of `setup.complete`. */
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
  const assistants = yield* AssistantService;

  const row = sql<{
    readonly token_hash: string | null;
    readonly completed_at: string | null;
  }>`SELECT token_hash, completed_at FROM setup_state WHERE singleton = 1`.pipe(
    Effect.map((rows) => rows[0]),
  );

  return {
    /** Returns whether first run is done, so the web app knows whether to route to `/setup`. */
    state: (): Effect.Effect<{ readonly complete: boolean }, SqlError> =>
      Effect.map(row, (state) => ({ complete: state?.completed_at != null })),

    /**
     * Checks whether a token is the outstanding setup token. Only its hash is
     * stored, so a copy of the database gives nobody a working token.
     */
    matchesToken: (token: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        row,
        (state) => state?.completed_at == null && state?.token_hash === hashToken(token),
      ),

    /**
     * Creates the user and the default assistant, marks setup complete and
     * returns a bearer token, so the caller is logged in when this returns.
     * The transport gate verifies the setup token before this runs. Fails
     * with `InvalidState` when setup is already complete, or when there is no
     * provider instance for the assistant to run on, and with `Validation`
     * when the timezone is not an IANA zone name. Every failure writes
     * nothing, so setup can be tried again.
     */
    complete: (
      input: CompleteInput,
    ): Effect.Effect<
      { readonly token: string },
      InvalidState | Validation | SettingError | GrantsError | Schema.SchemaError | SqlError
    > =>
      Effect.gen(function* () {
        yield* validateTimezone(input.timezone, ["timezone"]);
        // Hashing a password takes tens of milliseconds and SQLite has one
        // writer, so it happens before the transaction opens, never inside it.
        const passwordHash = yield* hashPassword(input.password, cost);
        const token = mintToken();

        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            // The UPDATE is the check: the caller whose UPDATE changes the row
            // finishes setup, and every other caller gets "already set up".
            // Reading the flag first and writing afterwards would let two
            // callers with the same token both pass.
            yield* sql`
              UPDATE setup_state SET completed_at = ${at}, token_hash = NULL
              WHERE singleton = 1 AND completed_at IS NULL
            `;
            const changed = yield* sql<{ readonly rows: number }>`SELECT changes() AS rows`;
            if ((changed[0]?.rows ?? 0) === 0) {
              return yield* Effect.fail(createInvalidStateError("Hercule is already set up."));
            }

            const user = yield* users.create(input.username, passwordHash);
            yield* settings.setForUser(user.id, "timezone", input.timezone);
            yield* audit.append({
              kind: "setup.completed",
              actor: USER_ACTOR,
              payload: { username: input.username },
            });
            // Inside the transaction because the caller is logged in when this
            // returns: if the token cannot be stored, setup did not happen,
            // rather than finishing with no token to return.
            const tokenHash = hashToken(token);
            const login = yield* credentials.issueLoginToken(user.id, tokenHash);
            // No request credential exists yet, so the new user acts through
            // the login token just issued.
            yield* assistants.create({ name: DEFAULT_ASSISTANT_NAME }).pipe(
              Effect.provideService(CurrentActor, {
                _tag: "user",
                userId: user.id,
                credential: { kind: "login", id: login.id, tokenHash },
              }),
              // The user holds every grant and the name is valid, so any of
              // these errors here is a bug rather than something to report.
              Effect.catchIf(
                (error) =>
                  error instanceof Forbidden ||
                  error instanceof Unauthenticated ||
                  error instanceof Validation,
                Effect.die,
              ),
            );
          }),
        );

        // The file exists only while setup is incomplete. Setup is done either
        // way, so a file that cannot be removed is logged as a warning rather
        // than failing the response.
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
  SqlClient.SqlClient | Users | Credentials | Settings | HerculeHome | AuditLog | AssistantService
> = Layer.effect(Setup)(make);
