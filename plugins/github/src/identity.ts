/**
 * Who the user is on GitHub, as the Connection records it, and the facts the
 * feeds work out from it: whether an account is the user's, and whether a
 * comment mentions the user.
 */
import type { GithubAccount } from "./github-objects";

/** The Connection's GitHub account. */
export interface GithubIdentity {
  /** The numeric GitHub user id, as a string; it survives a rename. */
  readonly accountId: string;
  /** The login, such as `octocat`. */
  readonly login: string;
}

/**
 * Checks whether an account is the user's. Compares the numeric id when
 * GitHub sent one, because a login can be renamed and then taken by someone
 * else, and the login, case-insensitively, otherwise. A null account, as
 * GitHub sends for a deleted one, is never the user's.
 */
export const isUserAccount = (identity: GithubIdentity, account: GithubAccount | null): boolean => {
  if (account === null) return false;
  if (account.id !== undefined) return String(account.id) === identity.accountId;
  return account.login.toLowerCase() === identity.login.toLowerCase();
};

/** Escapes the characters a regular expression gives a meaning to. */
const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Returns where `text` mentions `login` as `@login`, case-insensitively, or
 * -1 when it does not. The mention must be a whole word: `@octocatz` and
 * `x@octocat.com` do not mention `octocat`, and neither does
 * `@octocat/reviewers`, which is a team mention when `octocat` is an
 * organization.
 */
export const findMention = (text: string, login: string): number => {
  const pattern = new RegExp(`(^|[^\\w@])@${escapeForPattern(login)}(?![\\w/-])`, "i");
  const match = pattern.exec(text);
  return match === null ? -1 : match.index + match[1]!.length;
};
