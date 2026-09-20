/**
 * What a user may write as a remote.
 *
 * The canonical form every spelling of one repository lands on - the identity a
 * second resource collides on and a credential request is matched against -
 * lives in `@hercule/protocol`, because the runner reads remotes by the same
 * rule. What is left here is the narrower question only the controller asks:
 * whether Hercule will hand this remote to git at all.
 */
import { canonicalRemoteOf } from "@hercule/protocol";

export { canonicalRemoteOf };

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** `scheme://` at the front, which tells a URL from git's scp-like spelling. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** `user@host:path`, git's own spelling, which carries no scheme. */
const SCP = /^[^@/]+@[^@/:]+:[^:]+$/;

/**
 * Whether Hercule will hand this remote to git: an `https://` URL, or git's own
 * `user@host:owner/repo`. Asked of what a user writes on a resource, and not of
 * what a machine reports: git names the remote it is talking to as `host/path`,
 * which is a canonical form rather than a spelling anyone would clone. Local
 * and shell-reachable spellings - `file://`, `ssh://` with a path, a bare path -
 * would make a checkout of whatever the machine happens to hold, and are
 * refused here, where the user can read why.
 */
export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  return scheme === null ? SCP.test(written) : scheme[0].toLowerCase() === "https://";
};

/** The last segment of a canonical remote: what a repository is called. */
export const repoNameOf = (canonicalRemote: string): string =>
  canonicalRemote.slice(canonicalRemote.lastIndexOf("/") + 1);
