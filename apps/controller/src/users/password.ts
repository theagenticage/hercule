/**
 * How a password is stored: argon2id, through Bun's own implementation (spec 13
 * section 4.2).
 *
 * A password is low-entropy and guessable, which is the one case where the slow
 * hash is the point; every other credential Hydra stores is a 256-bit random
 * token and uses SHA-256 (`../credentials/token.ts`).
 *
 * The stored value is a PHC string,
 * `$argon2id$v=19$m=65536,t=2,p=1$<salt>$<hash>`, so the parameters and the
 * salt travel with the hash: raising {@link PRODUCTION_PASSWORD_PARAMS} later
 * leaves every existing password verifiable, and a rehash happens the next time
 * the user sets one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The argon2id cost this controller hashes new passwords at. */
export interface PasswordParams {
  /** KiB of memory the hash occupies. */
  readonly memoryCost: number;
  /** How many passes over that memory. */
  readonly timeCost: number;
}

/**
 * 64 MiB and two passes: Bun's default, comfortably above the OWASP argon2id
 * floor of 19 MiB, and about 70 ms on an M-series laptop. Login is not a hot
 * path, so the cost buys what it should.
 */
export const PRODUCTION_PASSWORD_PARAMS: PasswordParams = { memoryCost: 65536, timeCost: 2 };

/**
 * 4 MiB and two passes: what tests hash at, about 3 ms. A suite that logs in
 * repeatedly is otherwise dominated by a cost it is not testing.
 */
export const TEST_PASSWORD_PARAMS: PasswordParams = { memoryCost: 4096, timeCost: 2 };

/**
 * What this controller hashes at. Production by default; a test provides the
 * reduced cost once, rather than every call site passing parameters down.
 */
export const PasswordCost = Context.Reference<PasswordParams>(
  "hydra/controller/users/PasswordCost",
  { defaultValue: () => PRODUCTION_PASSWORD_PARAMS },
);

/** Hashes a password for storage. The plaintext is never held beyond this call. */
export const hashPassword = (
  password: string,
  params: PasswordParams = PRODUCTION_PASSWORD_PARAMS,
): Effect.Effect<string> =>
  Effect.promise(() =>
    Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: params.memoryCost,
      timeCost: params.timeCost,
    }),
  );

/**
 * Whether a password matches a stored hash. The parameters come from the hash
 * itself, so this verifies passwords written under any earlier cost.
 *
 * A stored value Bun cannot parse answers false rather than failing: it is not
 * a hash this password matches, and a login attempt is the wrong place to learn
 * that a row was edited outside Hydra.
 */
export const verifyPassword = (password: string, hash: string): Effect.Effect<boolean> =>
  Effect.promise(() => Bun.password.verify(password, hash).catch(() => false));
