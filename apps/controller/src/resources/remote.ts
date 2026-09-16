/**
 * What two spellings of one repository have in common, and what is not a
 * remote at all.
 *
 * `git@github.com:Acme/Web.git` and `https://GitHub.com/acme/web` are the same
 * repository, and Hydra has to know that: a second resource on a remote it
 * already holds is a conflict, and the credential a machine asks for names the
 * remote git was about to talk to rather than any id.
 *
 * The canonical form is `host/owner/repo`, lowercased, with the scheme, the
 * user, the port and a `.git` suffix taken off. Case is folded on the path as
 * well as the host: GitHub itself treats `Acme/Web` and `acme/web` as one
 * repository, and a host that did not would still be one repository to the user
 * who wrote both.
 *
 * Two spellings are accepted and nothing else: `https://host/owner/repo` and
 * git's own `user@host:owner/repo`. What that rules out is what a machine would
 * otherwise be handed: a word beginning with `-`, which git reads as an option
 * rather than a remote; `.` or `..` as a path segment, which is a directory
 * above the workspace; and local schemes like `file://` and `ssh://` with a
 * path, which would make a checkout of whatever that machine happens to hold.
 */

/** `scheme://` at the front, which tells a URL from git's scp-like spelling. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A user before the host, in either spelling. */
const USER = /^[^@/]*@/;

/** A port after the host of a URL. */
const PORT = /^([^/]+):\d+(\/|$)/;

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** `user@host:path`, git's own spelling, which carries no scheme. */
const SCP = /^[^@/]+@[^@/:]+:[^:]+$/;

/** A segment that climbs out of the path it is in, or stands still in it. */
const isTraversal = (segment: string): boolean => segment === "." || segment === "..";

/**
 * Whether Hydra will hand this remote to git: an `https://` URL, or git's own
 * `user@host:owner/repo`. Asked of what a user writes on a resource, and not of
 * what a machine reports: git names the remote it is talking to as `host/path`,
 * which is a canonical form rather than a spelling anyone would clone.
 */
export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  return scheme === null ? SCP.test(written) : scheme[0].toLowerCase() === "https://";
};

/**
 * The canonical form of a remote, or `undefined` for something that names no
 * repository: a path with no owner in it, a segment that climbs out of it, or a
 * word that is not a remote at all. Every spelling of one repository lands on
 * one string, which is what a second resource collides on and what a machine's
 * credential request is matched against.
 */
export const canonicalRemoteOf = (remote: string): string | undefined => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return undefined;
  const url = SCHEME.exec(written);
  let rest = written.replace(SCHEME, "").replace(USER, "");
  // Without a scheme the first colon separates the host from the path, which is
  // how git spells `host:owner/repo`; with one it can only be a port.
  rest = url === null ? rest.replace(":", "/") : rest.replace(PORT, "$1$2");
  const parts = rest.split("/").filter((part) => part.length > 0);
  if (parts.length < 2 || parts.some(isTraversal)) return undefined;
  const host = parts[0]!.toLowerCase();
  const path = parts
    .slice(1)
    .join("/")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return path.length === 0 ? undefined : `${host}/${path}`;
};

/** The last segment of a canonical remote: what a repository is called. */
export const repoNameOf = (canonicalRemote: string): string =>
  canonicalRemote.slice(canonicalRemote.lastIndexOf("/") + 1);
