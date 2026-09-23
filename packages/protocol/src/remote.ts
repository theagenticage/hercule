/**
 * The canonical form of a git remote, shared by every spelling of the same
 * repository.
 *
 * `git@github.com:Acme/Web.git` and `https://GitHub.com/acme/web` are the same
 * repository, and every part of the system has to agree on that:
 *
 * - a second resource on a remote the controller already has is a conflict;
 * - a machine's credential request refers to the remote git is about to use,
 *   not to an id.
 *
 * So the canonical form is computed here, in the one package every role links,
 * and no two parts can disagree about what a remote is.
 *
 * The canonical form is `host/owner/repo`, lowercased, with the scheme, the
 * user, the port and a `.git` suffix removed. Case is folded on the path as
 * well as the host: GitHub itself treats `Acme/Web` and `acme/web` as one
 * repository, and a host that did not would still be one repository to the user
 * who wrote both.
 *
 * It rejects what nothing should pass to git:
 *
 * - a word beginning with `-`, which git reads as an option rather than a
 *   remote;
 * - `.` or `..` as a path segment, which points to a directory above the
 *   workspace;
 * - anything with no path, which identifies no repository.
 *
 * Which of the remaining forms a *user* may write on a resource is a narrower
 * rule that the controller applies.
 */

/** `scheme://` at the start, which tells a URL apart from git's scp-like form. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A user before the host, in either form. */
const USER = /^[^@/]*@/;

/** A port after the host of a URL. */
const PORT = /^([^/]+):\d+(\/|$)/;

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** Checks whether a path segment is `.` or `..`. */
const isTraversal = (segment: string): boolean => segment === "." || segment === "..";

/**
 * Returns the canonical form of a remote. Returns `undefined` when the text
 * does not identify a repository: a path with no owner, a `.` or `..` segment,
 * or a word that is not a remote at all. Every spelling of one repository
 * gives the same string, which is what a duplicate resource is detected by and
 * what a machine's credential request is matched against.
 */
export const canonicalizeRemote = (remote: string): string | undefined => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return undefined;
  const url = SCHEME.exec(written);
  let rest = written.replace(SCHEME, "").replace(USER, "");
  // Without a scheme, the first colon separates the host from the path, as in
  // git's `host:owner/repo` form; with a scheme, it can only be a port.
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
