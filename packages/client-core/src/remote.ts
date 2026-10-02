/**
 * Checks whether a git remote is one Hercule will pass to git. The form checks
 * this before it sends, so the user sees the error at once instead of after a
 * round trip to the controller.
 *
 * The controller's `isClonableRemote` (`apps/controller/src/resources/remote.ts`)
 * makes the final decision; this copy only rejects early. Both apply the same
 * rules, so a remote that passes here is one the controller accepts:
 *
 * - an `https://` URL, or git's scp-like `user@host:owner/repo`;
 * - never a value that starts with `-`, which git would read as an option.
 */

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** A leading `scheme://`, which tells a URL apart from git's scp-like form. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** `user@host:path`, git's scp-like form, which has no scheme. */
const SCP = /^[^@/]+@[^@/:]+:[^:]+$/;

export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  return scheme === null ? SCP.test(written) : scheme[0].toLowerCase() === "https://";
};

/** The form's error for an invalid remote. It shows both accepted forms. */
export const REMOTE_REFUSAL = "Write an https:// URL or git@host:owner/repo";

/**
 * Returns the repository's path on its host, as written, from a remote:
 * `rogier/webshop` from `git@github.com:rogier/webshop.git` or from
 * `https://github.com/rogier/webshop`. A `.git` suffix and a trailing `/` are
 * dropped; the case is kept, because the name is shown to the user.
 *
 * Returns null when the remote is not one `isClonableRemote` accepts, or when
 * its path has fewer than two segments (an owner and a repository).
 */
export const parseRepositoryName = (remote: string): string | null => {
  if (!isClonableRemote(remote)) return null;
  const written = remote.trim();
  // A URL's path starts at the first `/` after its host; the scp-like form's
  // path starts after the colon that follows the host.
  const path = SCHEME.test(written)
    ? written.replace(SCHEME, "").replace(/^[^/]*/, "")
    : written.slice(written.indexOf(":") + 1);
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.length < 2 ? null : segments.join("/");
};

/**
 * Checks whether `remote` is a repository on github.com, so a screen draws
 * the GitHub mark beside it only when the repository really is on GitHub.
 * The host is compared without its case, and a user or a port in a URL is
 * ignored. Returns false for a remote `isClonableRemote` refuses.
 */
export const isGitHubRemote = (remote: string): boolean => {
  if (!isClonableRemote(remote)) return false;
  const written = remote.trim();
  // A URL's host sits between its scheme and the first `/`, after any
  // `user@` and before any `:port`. The scp-like form's host sits between
  // the `@` and the colon, and its path holds no colon.
  const host = SCHEME.test(written)
    ? written.replace(SCHEME, "").replace(/\/.*$/, "").replace(/^.*@/, "").replace(/:\d*$/, "")
    : written.slice(written.indexOf("@") + 1, written.lastIndexOf(":"));
  return host.toLowerCase() === "github.com";
};
