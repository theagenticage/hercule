/**
 * What two spellings of one repository have in common.
 *
 * `git@github.com:Acme/Web.git` and `https://GitHub.com/acme/web` are the same
 * repository, and every end that names one has to agree that they are: a second
 * resource on a remote the controller already holds is a conflict, and the
 * credential a machine asks for names the remote git was about to talk to
 * rather than any id, so the question is asked once, in the one package every
 * role links, and no two ends can disagree about what a remote is.
 *
 * The canonical form is `host/owner/repo`, lowercased, with the scheme, the
 * user, the port and a `.git` suffix taken off. Case is folded on the path as
 * well as the host: GitHub itself treats `Acme/Web` and `acme/web` as one
 * repository, and a host that did not would still be one repository to the user
 * who wrote both.
 *
 * What it refuses is what nothing should hand to git: a word beginning with
 * `-`, which git reads as an option rather than a remote; `.` or `..` as a path
 * segment, which is a directory above the workspace; and anything with no path
 * on it, which names no repository. Which of the forms that survive a *user*
 * may write on a resource is a narrower, controller-side rule.
 */

/** `scheme://` at the front, which tells a URL from git's scp-like spelling. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A user before the host, in either spelling. */
const USER = /^[^@/]*@/;

/** A port after the host of a URL. */
const PORT = /^([^/]+):\d+(\/|$)/;

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** A segment that climbs out of the path it is in, or stands still in it. */
const isTraversal = (segment: string): boolean => segment === "." || segment === "..";

/**
 * The canonical form of a remote, or `undefined` for something that names no
 * repository: a path with no owner in it, a segment that climbs out of it, or a
 * word that is not a remote at all. Every spelling of one repository lands on
 * one string, which is what a second resource collides on and what a machine's
 * credential request is matched against.
 */
export const canonicalizeRemote = (remote: string): string | undefined => {
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
