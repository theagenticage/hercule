/**
 * Hashes and verifies passwords with argon2id, using Bun's implementation.
 *
 * A password has low entropy and can be guessed, so a slow hash is needed. It
 * is the only such case: every other stored credential is a 256-bit random
 * token and uses SHA-256 (`../credentials/token.ts`).
 *
 * The stored value is a PHC string,
 * `$argon2id$v=19$m=65536,t=2,p=1$<salt>$<hash>`, so the parameters and the
 * salt are stored with the hash. Raising {@link PRODUCTION_PASSWORD_PARAMS}
 * later keeps every existing password verifiable, and the password is hashed
 * with the new cost the next time the user sets one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The argon2id cost parameters for hashing new passwords. */
export interface PasswordParams {
  /** The memory the hash uses, in KiB. */
  readonly memoryCost: number;
  /** The number of passes over that memory. */
  readonly timeCost: number;
}

/**
 * 64 MiB and two passes: Bun's default, comfortably above the OWASP argon2id
 * minimum of 19 MiB, and about 70 ms on an M-series laptop. Login is not a hot
 * path, so the cost is affordable.
 */
export const PRODUCTION_PASSWORD_PARAMS: PasswordParams = { memoryCost: 65536, timeCost: 2 };

/**
 * 4 MiB and two passes, about 3 ms, for tests. Otherwise a test suite that
 * logs in many times would spend most of its time on hashing, which it is not
 * testing.
 */
export const TEST_PASSWORD_PARAMS: PasswordParams = { memoryCost: 4096, timeCost: 2 };

/**
 * The cost this controller hashes passwords at. It defaults to the production
 * cost; a test provides the lower cost once, rather than every call site
 * passing parameters down.
 */
export const PasswordCost = Context.Reference<PasswordParams>(
  "hercule/controller/users/PasswordCost",
  { defaultValue: () => PRODUCTION_PASSWORD_PARAMS },
);

/**
 * Hashes a password for storage and returns the PHC string. The plaintext is
 * not kept after this call.
 *
 * The cost is always passed in, from {@link PasswordCost}. A default here would
 * be a second way to make the same decision, and a caller who forgot to pass
 * the cost would get the production cost in a test.
 */
export const hashPassword = (password: string, params: PasswordParams): Effect.Effect<string> =>
  Effect.promise(() =>
    Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: params.memoryCost,
      timeCost: params.timeCost,
    }),
  );

/**
 * Checks whether a password matches a stored hash. The parameters are read
 * from the hash itself, so this verifies passwords hashed at any earlier cost.
 *
 * Returns false, rather than failing, for a stored value Bun cannot parse: the
 * password does not match it, and a login attempt is the wrong place to report
 * that a row was edited outside the controller.
 */
export const verifyPassword = (password: string, hash: string): Effect.Effect<boolean> =>
  Effect.promise(() => Bun.password.verify(password, hash).catch(() => false));
