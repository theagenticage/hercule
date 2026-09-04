/**
 * Bounds on free text (spec 11 section 1.5).
 *
 * Every string a caller controls has a maximum length, declared here rather
 * than left to the transport: an unbounded field is an unbounded write, and the
 * audit log keeps what it is told for at least 90 days. The bound belongs in
 * the contract so the refusal is one `validation` error before any handler
 * runs, identical for every client.
 */
import { Schema } from "effect";

/** A string of at least `minimum` and at most `maximum` characters. */
export const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isLengthBetween(minimum, maximum));

/**
 * The shortest password Hydra accepts. Spec 13 section 1 puts brute-force
 * lockout out of scope, so on a LAN bind the password is the whole perimeter
 * and a one-character one is not a perimeter.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The longest secret anyone may present. A login attempt is unauthenticated, so
 * the maximum is the only thing standing between an anonymous caller and an
 * arbitrarily large hash and audit row.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * A password being set. Both bounds apply: this is a value the user chooses.
 */
export const NewPassword = bounded(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);

/**
 * A password being presented. Only the maximum applies: refusing a short one
 * before checking it would tell an anonymous caller the policy, and the answer
 * to a wrong password is `unauthenticated` either way.
 */
export const PresentedPassword = bounded(1, MAX_PASSWORD_LENGTH);

/** A login name. */
export const Username = bounded(1, 64);

/**
 * The largest secret value the API stores, in characters.
 *
 * A secret is the largest thing v1 accepts - a private key, a PEM bundle, a
 * service-account JSON - so the bound is generous, but it is a bound: it is
 * caller-controlled text that lands in the database, and the listener's own 1
 * MiB body cap is a limit on the request, not on the field.
 */
export const MAX_SECRET_VALUE_LENGTH = 64 * 1024;

/** A secret's value. Empty is not a secret; use `secret.delete` instead. */
export const SecretValue = bounded(1, MAX_SECRET_VALUE_LENGTH);
