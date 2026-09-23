/**
 * Password login and logout.
 *
 * Login is the only place in Hercule that checks a password. It returns an
 * opaque bearer token with a rolling 30-day expiry: every authenticated use
 * moves the expiry later (`Credentials.renewLoginToken`, called by the
 * transport gate), and logout revokes the token on the server.
 *
 * A login attempt for a username that does not exist still verifies a
 * password, against a fixed hash. Skipping the check would respond in a
 * millisecond instead of tens of milliseconds, which would let anyone find out
 * which usernames exist. The response is the same either way: the error message
 * says only that the username or password is incorrect.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createUnauthenticatedError,
  createValidationError,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { CurrentActor, USER_ACTOR } from "../actor";
import { Credentials, hashToken, mintToken } from "../credentials";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { Users, verifyPassword } from "../users";

/** The input of login. The password is not kept after it is verified. */
export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

/**
 * An argon2id hash of a value nobody knows. Login verifies against it when the
 * username does not exist, so an unknown username takes as long as a known one.
 * It uses the production parameters. A test that logs in with reduced
 * parameters compares two different costs anyway, and only real logins face
 * an attacker.
 */
const ABSENT_USER_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$YLIlnj5jWzl2h0eLh5bwJnAprHHSQtwEWWQ6w/A1kTs$sXIzd3nAnS1MBdrKw0b5NcF5jwAdeRXxdA6YYznxOFk";

/** One error message for a wrong username and a wrong password, so neither is confirmed. */
const WRONG = "the username or password is incorrect";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const users = yield* Users;
  const credentials = yield* Credentials;
  const audit = yield* AuditLog;

  return {
    /**
     * Verifies the password and returns a new bearer token with a rolling
     * 30-day expiry. Fails with `Unauthenticated` when the username or password
     * is wrong.
     */
    login: (
      input: LoginInput,
    ): Effect.Effect<
      { readonly token: string; readonly expiresAt: string },
      Unauthenticated | SqlError
    > =>
      Effect.gen(function* () {
        const user = yield* users.findByUsername(input.username);
        const matches = yield* verifyPassword(
          input.password,
          Option.match(user, {
            onNone: () => ABSENT_USER_HASH,
            onSome: (found) => found.passwordHash,
          }),
        );
        if (Option.isNone(user) || !matches) {
          // The username is the only part of the attempt that is safe to keep:
          // the password is never written anywhere, even for a failed attempt.
          // The actor is null, because the credential resolved to no one. An
          // entry stamped with the user would claim someone was authenticated,
          // when the entry records exactly that no one was.
          //
          // The append is not part of any other write, so there is nothing to
          // roll back with it. A database error here must not turn a wrong
          // password into a 500. The caller gets the correct answer about their
          // credential, and the database error goes to the log, where the next
          // write in any operation will report the same problem.
          yield* audit
            .append({
              kind: "auth.login.failed",
              actor: null,
              payload: { username: input.username },
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logError("Cannot record a failed login attempt", cause),
              ),
              Effect.ignore,
            );
          return yield* Effect.fail(createUnauthenticatedError(WRONG));
        }

        const token = mintToken();
        const record = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const issued = yield* credentials.issueLoginToken(user.value.id, hashToken(token));
            yield* audit.append({
              kind: "auth.login.succeeded",
              actor: USER_ACTOR,
              payload: { username: input.username },
            });
            return issued;
          }),
        );
        return { token, expiresAt: record.expiresAt };
      }),

    /**
     * Revokes the login bearer token the call was made with. Fails with
     * `Validation` when the call was made with any other credential. An API key
     * is not a login: it is revoked with `apiKey.revoke`, which takes the key's
     * id rather than whichever credential happens to be in the header.
     */
    logout: (): Effect.Effect<Record<string, never>, Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* CurrentActor;
        if (actor._tag !== "user" || actor.credential.kind !== "login") {
          return yield* Effect.fail(
            createValidationError(
              [{ path: [], message: "logout revokes a login token; use apiKey.revoke for a key" }],
              "this credential is not a login token",
            ),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* credentials.revokeLoginToken(actor.credential.tokenHash);
            yield* audit.append({ kind: "auth.logout.succeeded", actor: USER_ACTOR, payload: {} });
            return {};
          }),
        );
      }),
  };
});

/** The auth service. */
export class Auth extends Context.Service<Auth, Effect.Success<typeof make>>()(
  "hercule/controller/auth/Auth",
) {}

export const AuthLayer: Layer.Layer<
  Auth,
  never,
  SqlClient.SqlClient | Users | Credentials | AuditLog
> = Layer.effect(Auth)(make);
