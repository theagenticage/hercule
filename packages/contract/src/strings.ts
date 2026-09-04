/**
 * Bounds on what a caller writes: how long a string may be, and how many items
 * a list may hold.
 *
 * Every string and every list a caller controls has a maximum, declared here
 * rather than left to the transport: an unbounded field is an unbounded write,
 * and the audit log keeps what it is told for at least 90 days. The bound
 * belongs in the contract so the refusal is one `validation` error before any
 * handler runs, identical for every client.
 */
import { Schema } from "effect";

/** A string of at least `minimum` and at most `maximum` characters. */
export const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isLengthBetween(minimum, maximum));

/** A list of at most `maximum` items. */
export const atMost = <S extends Schema.Top>(item: S, maximum: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maximum));

/**
 * The shortest password Hydra accepts. There is no brute-force lockout, so on a
 * LAN bind the password is the whole perimeter, and a one-character one is not
 * a perimeter.
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
export const NewPassword = Schema.String.check(
  Schema.isMinLength(MIN_PASSWORD_LENGTH, {
    message: `A password is at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
  }),
  Schema.isMaxLength(MAX_PASSWORD_LENGTH, {
    message: `A password is at most ${String(MAX_PASSWORD_LENGTH)} characters.`,
  }),
);

/** The longest login name. */
export const MAX_USERNAME_LENGTH = 64;

/**
 * A password being presented. Only the maximum applies: refusing a short one
 * before checking it would tell an anonymous caller the policy, and the answer
 * to a wrong password is `unauthenticated` either way. An empty field is not a
 * policy, so what it says is what a person needs to do about it.
 */
export const PresentedPassword = Schema.String.check(
  Schema.isMinLength(1, { message: "Enter your password." }),
  Schema.isMaxLength(MAX_PASSWORD_LENGTH, {
    message: `A password is at most ${String(MAX_PASSWORD_LENGTH)} characters.`,
  }),
);

/** A login name. */
export const Username = Schema.String.check(
  Schema.isMinLength(1, { message: "Enter your username." }),
  Schema.isMaxLength(MAX_USERNAME_LENGTH, {
    message: `A username is at most ${String(MAX_USERNAME_LENGTH)} characters.`,
  }),
);

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

/**
 * The longest IANA zone name. The longest the zone database carries is under
 * half of this; the bound is here because the value is caller-controlled text
 * that every `settings.read` hands back.
 */
export const MAX_TIMEZONE_LENGTH = 64;

/**
 * An IANA zone name. Which names exist is the runtime's to say and changes with
 * the zone database, so the contract bounds the length and the client that
 * offers the field picks from the list its own runtime knows.
 */
export const Timezone = bounded(1, MAX_TIMEZONE_LENGTH);
