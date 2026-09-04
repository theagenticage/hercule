/**
 * Password login and logout (spec 13 section 4.2).
 *
 * Login is the only place in Hydra that checks a password. It hands back an
 * opaque 30-day rolling bearer token: every authenticated use pushes the expiry
 * out (`Credentials.renewLoginToken`, called by the transport gate), and logout
 * revokes it server-side.
 *
 * A login attempt for a username that does not exist still verifies a password,
 * against a fixed hash. Skipping the verify would answer in a millisecond
 * instead of tens of them and turn login into an oracle for which usernames
 * exist. The response is the same either way, and says only that the pair is
 * wrong.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  unauthenticated,
  validation,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { CurrentActor } from "../actor";
import { Credentials, hashToken, mintToken } from "../credentials";
import { Users, verifyPassword } from "../users";

/** What login takes. The password is never held beyond the verify. */
export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

/**
 * An argon2id hash of a value nobody knows, verified against when the username
 * does not exist so that a miss costs what a hit costs. Its parameters are the
 * production ones; a test that logs in with reduced parameters is comparing
 * two different costs anyway, and only real logins have an attacker.
 */
const ABSENT_USER_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$YLIlnj5jWzl2h0eLh5bwJnAprHHSQtwEWWQ6w/A1kTs$sXIzd3nAnS1MBdrKw0b5NcF5jwAdeRXxdA6YYznxOFk";

/** One message for both halves of a wrong login, so neither is confirmed. */
const WRONG = "the username or password is incorrect";

const make = Effect.gen(function* () {
  const users = yield* Users;
  const credentials = yield* Credentials;

  return {
    /** Verifies the password and mints the 30-day rolling bearer token. */
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
          // TODO(#57 WP5): audit auth.login.failed
          return yield* Effect.fail(unauthenticated(WRONG));
        }

        const token = mintToken();
        const record = yield* credentials.issueLoginToken(user.value.id, hashToken(token));
        // TODO(#57 WP5): audit auth.login.succeeded
        return { token, expiresAt: record.expiresAt };
      }),

    /**
     * Revokes the login bearer token the call was made with. An API key is not
     * a login: revoking one is `apiKey.revoke`, which names the key rather than
     * whichever credential happens to be in the header.
     */
    logout: (): Effect.Effect<Record<string, never>, Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* CurrentActor;
        if (actor._tag !== "user" || actor.credential.kind !== "login") {
          return yield* Effect.fail(
            validation(
              [{ path: [], message: "logout revokes a login token; use apiKey.revoke for a key" }],
              "this credential is not a login token",
            ),
          );
        }
        yield* credentials.revokeLoginToken(actor.credential.tokenHash);
        // TODO(#57 WP5): audit auth.logout
        return {};
      }),
  };
});

/** The auth service (ADR 0031: every operation is a method on an Effect service). */
export class Auth extends Context.Service<Auth, Effect.Success<typeof make>>()(
  "hydra/controller/auth/Auth",
) {}

export const AuthLayer: Layer.Layer<Auth, never, Users | Credentials> = Layer.effect(Auth)(make);
