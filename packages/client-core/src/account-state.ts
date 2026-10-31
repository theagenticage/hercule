/**
 * What the Providers page says when a Provider Account needs the user (spec 06
 * section 18.3, spec 17 §Settings, Providers): the card's state line and its
 * button, and the account sheet's Credential section, both read this.
 */
import type { Provider, ProviderAccount } from "@hercule/contract";
import {
  findHarnessLoginMethod,
  listProviderAccountCredentialFields,
  listSignedInDefaultHarnessSnapshots,
  signsInPerMachine,
} from "./provider-accounts";
import { formatDay, readCalendarDate, countCalendarDaysBetween } from "./time-context";
import { formatMessageTime } from "./threads/message-time";

/** How long before its expiry an account starts to say so. */
const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What fixes a state, and the label of its button:
 *
 * - `replace-key`: the user types a new key;
 * - `new-token`: the user runs the token flow again on a machine with Claude Code;
 * - `sign-in`: the user signs in on a machine, in the account sheet's Machines section.
 */
export type AccountFix =
  | { readonly kind: "replace-key"; readonly label: "Replace key" }
  | { readonly kind: "new-token"; readonly label: "Make a new token" }
  | { readonly kind: "sign-in"; readonly label: "Sign in" };

/**
 * Whether the account needs the user:
 *
 * - `failed`: the provider refused the account's key or token;
 * - `expired`: the credential's `expiresAt` has passed;
 * - `expiring`: it expires within 30 days;
 * - `signed-out`: an account that signs in on each machine is signed in on none;
 * - `ok`: nothing is needed.
 *
 * `tone` is the hue the state is drawn in: `fail` for a state that stops the
 * account, `attention` for one that will. `message` is the provider's own
 * words for a refusal, else `null`.
 */
export type AccountState =
  | { readonly kind: "ok" }
  | {
      readonly kind: "failed" | "expired" | "expiring" | "signed-out";
      readonly tone: "fail" | "attention";
      readonly text: string;
      readonly detail: string | null;
      readonly message: string | null;
      /** `null` when the account's kind is no longer declared, so nobody knows what would fix it. */
      readonly fix: AccountFix | null;
    };

type Credential = "key" | "token" | "per-machine" | "unknown";

const classifyCredential = (
  providers: ReadonlyArray<Provider>,
  account: Pick<ProviderAccount, "providerId" | "kind">,
): Credential => {
  if (signsInPerMachine(providers, account)) return "per-machine";
  if (findHarnessLoginMethod(providers, account) === "create-token") return "token";
  return listProviderAccountCredentialFields(providers, account).length > 0 ? "key" : "unknown";
};

/**
 * Returns the button that gives the account a new credential, or `null` for an
 * account that has none to replace: one that signs in on each machine, whose
 * sign-in the account sheet's Machines section runs, or whose kind its
 * provider no longer declares. A key is replaced by typing a new one; the
 * Claude subscription token by running the token flow again.
 */
export const findCredentialReplacement = (
  providers: ReadonlyArray<Provider>,
  account: Pick<ProviderAccount, "providerId" | "kind">,
): Extract<AccountFix, { kind: "replace-key" | "new-token" }> | null => {
  switch (classifyCredential(providers, account)) {
    case "key":
      return { kind: "replace-key", label: "Replace key" };
    case "token":
      return { kind: "new-token", label: "Make a new token" };
    case "per-machine":
    case "unknown":
      return null;
  }
};

/** Returns the date as "31 Oct", or "31 Oct 2027" when it is not in the year of `now`. */
const formatExpiryDate = (instant: Date, timezone: string, now: Date): string | undefined => {
  const day = formatDay(instant, timezone);
  const year = readCalendarDate(instant, timezone)?.year;
  return day === undefined || year === undefined || year === readCalendarDate(now, timezone)?.year
    ? day
    : `${day} ${String(year)}`;
};

/**
 * Returns how many calendar days lie between today and `expiresAt` in
 * `timezone`, the way a person counts: 0 for later today, 1 for tomorrow.
 */
const countDaysUntil = (expiresAt: Date, timezone: string, now: Date): number =>
  countCalendarDaysBetween(now, expiresAt, timezone) ??
  Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);

const describeDaysLeft = (days: number): string =>
  days <= 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires in ${String(days)} days`;

/**
 * Decides what the account needs from the user, checking in this order:
 *
 * 1. a refusal by the provider (`failure`): "Key refused" or "Token refused",
 *    with the provider's own words as `message`;
 * 2. a credential that has expired: "Expired";
 * 3. a credential that expires within 30 days: "Expires in 12 days", "Expires
 *    tomorrow" or "Expires today", counted in calendar days in `timezone`;
 * 4. an account that signs in on each machine and is signed in on none:
 *    "Signed out".
 *
 * Returns `{ kind: "ok" }` when none applies. Each state names the button
 * that fixes it. The result depends on `now`, so a caller that draws again
 * later sees a credential expire.
 */
export const decideAccountState = (
  providers: ReadonlyArray<Provider>,
  account: Pick<
    ProviderAccount,
    "providerId" | "kind" | "expiresAt" | "failure" | "defaultHarnessId" | "snapshots"
  >,
  timezone: string,
  now: Date,
): AccountState => {
  const credential = classifyCredential(providers, account);
  const fix =
    credential === "per-machine"
      ? ({ kind: "sign-in", label: "Sign in" } as const)
      : findCredentialReplacement(providers, account);
  const { failure, expiresAt } = account;

  if (failure !== null) {
    const failedAt = formatMessageTime(new Date(failure.failedAt), timezone, now);
    return {
      kind: "failed",
      tone: "fail",
      text:
        credential === "key"
          ? "Key refused"
          : credential === "token"
            ? "Token refused"
            : "Credential refused",
      detail: failedAt === undefined ? null : `at ${failedAt}`,
      message: failure.message,
      fix,
    };
  }

  if (expiresAt !== null) {
    const expiry = new Date(expiresAt);
    const date = formatExpiryDate(expiry, timezone, now);
    const detail = date === undefined ? null : `on ${date}`;
    if (expiry.getTime() <= now.getTime()) {
      return { kind: "expired", tone: "fail", text: "Expired", detail, message: null, fix };
    }
    if (expiry.getTime() - now.getTime() <= EXPIRY_WARNING_MS) {
      return {
        kind: "expiring",
        tone: "attention",
        text: describeDaysLeft(countDaysUntil(expiry, timezone, now)),
        detail,
        message: null,
        fix,
      };
    }
  }

  if (credential === "per-machine" && listSignedInDefaultHarnessSnapshots(account).length === 0) {
    return {
      kind: "signed-out",
      tone: "fail",
      text: "Signed out",
      detail: null,
      message: null,
      fix,
    };
  }
  return { kind: "ok" };
};

/**
 * Returns when the account's credential stops working, such as "Expires 31 Oct
 * 2027", or "Expired 31 Oct 2026" once it has, for the account sheet's
 * Credential section. Returns `null` for an account whose credential does not
 * expire.
 */
export const describeCredentialExpiry = (
  account: Pick<ProviderAccount, "expiresAt">,
  timezone: string,
  now: Date,
): string | null => {
  if (account.expiresAt === null) return null;
  const expiry = new Date(account.expiresAt);
  const date = formatExpiryDate(expiry, timezone, now);
  if (date === undefined) return null;
  return `${expiry.getTime() <= now.getTime() ? "Expired" : "Expires"} ${date}`;
};
