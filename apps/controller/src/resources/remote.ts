/**
 * Which remotes a user may enter on a resource.
 *
 * The canonical form - which every spelling of one repository converts to, and
 * which duplicate resources and credential requests are matched on - lives in
 * `@hercule/protocol`, because the runner canonicalizes remotes by the same
 * rule. This module holds the narrower check only the controller needs:
 * whether Hercule will pass this remote to git at all.
 */
export { canonicalizeRemote } from "@hercule/protocol";

/** A leading dash, which git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** A leading `scheme://`, which tells a URL apart from git's scp-like syntax. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * `user@host:path`, git's scp-like syntax, which has no scheme. The user has
 * no colon in it, so it cannot carry a password.
 */
const SCP = /^[^@/:]+@[^@/:]+:[^:]+$/;

/**
 * Checks whether a URL remote has a user name or password before its host, as
 * in `https://user:token@github.com/acme/web`. Returns false for git's
 * scp-like `git@host:owner/repo`, whose user is the SSH account every user of
 * the host shares, not a credential.
 */
export const hasUserinfo = (remote: string): boolean => {
  const written = remote.trim();
  const scheme = SCHEME.exec(written);
  if (scheme === null) return false;
  const authority = written.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
};

/**
 * Checks whether Hercule will pass this remote to git: an `https://` URL with
 * no user name or password, or git's scp-like `user@host:owner/repo`. Use it
 * on what a user enters on a resource, not on what a runner reports: git
 * reports the remote it contacts as `host/path`, which is a canonical form
 * rather than something anyone would clone.
 *
 * Every other form is rejected here, where the user can read why:
 *
 * - `file://`, `ssh://` with a path, or a bare path would check out whatever
 *   happens to be on the runner;
 * - a user name or password in an `https://` URL would be stored with the
 *   resource and shown wherever the remote is, while Hercule hands git its
 *   credential from a Connection instead.
 */
export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  if (scheme === null) return SCP.test(written);
  return scheme[0].toLowerCase() === "https://" && !hasUserinfo(written);
};

/** Returns the repository's name, which is the last segment of its canonical remote. */
export const extractRepoName = (canonicalRemote: string): string =>
  canonicalRemote.slice(canonicalRemote.lastIndexOf("/") + 1);
