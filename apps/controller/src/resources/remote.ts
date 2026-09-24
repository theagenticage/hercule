/**
 * Which remotes a user may enter on a resource.
 *
 * The canonical form - which every spelling of one repository converts to, and
 * which duplicate resources and credential requests are matched on - lives in
 * `@hercule/protocol`, because the runner canonicalizes remotes by the same
 * rule. This module holds the narrower check only the controller needs:
 * whether Hercule will pass this remote to git at all.
 */
import { canonicalizeRemote } from "@hercule/protocol";

export { canonicalizeRemote as canonicalRemoteOf };

/** A leading dash, which git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** A leading `scheme://`, which tells a URL apart from git's scp-like syntax. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** `user@host:path`, git's scp-like syntax, which has no scheme. */
const SCP = /^[^@/]+@[^@/:]+:[^:]+$/;

/**
 * Checks whether Hercule will pass this remote to git: an `https://` URL, or
 * git's scp-like `user@host:owner/repo`. Use it on what a user enters on a
 * resource, not on what a runner reports: git reports the remote it contacts
 * as `host/path`, which is a canonical form rather than something anyone would
 * clone. Other forms - `file://`, `ssh://` with a path, a bare path - would
 * check out whatever happens to be on the runner, so they are rejected here,
 * where the user can read why.
 */
export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  return scheme === null ? SCP.test(written) : scheme[0].toLowerCase() === "https://";
};

/** Returns the repository's name, which is the last segment of its canonical remote. */
export const extractRepoName = (canonicalRemote: string): string =>
  canonicalRemote.slice(canonicalRemote.lastIndexOf("/") + 1);
