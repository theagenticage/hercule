/**
 * Checks whether a git remote is one Hercule will pass to git, and reads the
 * parts a screen shows. The form checks a remote before it sends, so the user
 * sees the error at once instead of after a round trip to the controller.
 *
 * The controller's `isClonableRemote` (`apps/controller/src/resources/remote.ts`)
 * makes the final decision; this copy only rejects early. Both apply the same
 * rules, so a remote that passes here is one the controller accepts:
 *
 * - an `https://` URL with no user name or password before its host, or git's
 *   scp-like `user@host:owner/repo`;
 * - never a value that starts with `-`, which git would read as an option.
 */

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** A leading `scheme://`, which tells a URL apart from git's scp-like form. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * `user@host:path`, git's scp-like form, which has no scheme. The user has no
 * colon in it, so it cannot carry a password.
 */
const SCP = /^[^@/:]+@[^@/:]+:[^:]+$/;

/**
 * Checks whether a URL remote has a user name or password before its host, as
 * in `https://user:token@github.com/acme/web`. Returns false for git's
 * scp-like `git@host:owner/repo`, whose user is the SSH account every user of
 * the host shares, not a credential.
 */
const hasUserinfo = (remote: string): boolean => {
  const written = remote.trim();
  const scheme = SCHEME.exec(written);
  if (scheme === null) return false;
  const authority = written.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
};

/**
 * Checks whether Hercule will pass this remote to git: an `https://` URL with
 * no user name or password, or git's scp-like `user@host:owner/repo`.
 */
export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  if (scheme === null) return SCP.test(written);
  return scheme[0].toLowerCase() === "https://" && !hasUserinfo(written);
};

/** The form's error for an invalid remote. It shows both accepted forms. */
export const REMOTE_REFUSAL = "Write an https:// URL or git@host:owner/repo";

/**
 * The form's error for an `https://` remote with a user name or password in
 * it. The remote is stored and shown as written, so a token in it would be on
 * screen wherever the remote is.
 */
export const REMOTE_USERINFO_REFUSAL =
  "Leave the user name and password out of the URL: Hercule stores and shows the URL as written.";

/**
 * Returns the form's error for `remote`, or `null` when Hercule will pass it
 * to git. A remote with a user name or password gets its own error, because
 * `REMOTE_REFUSAL` asks for the very shape the user wrote.
 */
export const describeRemoteRefusal = (remote: string): string | null => {
  if (isClonableRemote(remote)) return null;
  return hasUserinfo(remote) && SCHEME.exec(remote.trim())?.[0].toLowerCase() === "https://"
    ? REMOTE_USERINFO_REFUSAL
    : REMOTE_REFUSAL;
};

/**
 * Splits a remote into its host, without a port, and its path on that host,
 * as written. Returns null when the remote is not one `isClonableRemote`
 * accepts.
 *
 * A URL's host sits between its scheme and the first `/`, and its path starts
 * at that `/`. The scp-like form's host sits between the `@` and the colon,
 * and its path starts after the colon.
 */
const splitRemote = (remote: string): { readonly host: string; readonly path: string } | null => {
  if (!isClonableRemote(remote)) return null;
  const written = remote.trim();
  if (!SCHEME.test(written)) {
    const colon = written.indexOf(":");
    return { host: written.slice(written.indexOf("@") + 1, colon), path: written.slice(colon + 1) };
  }
  const rest = written.replace(SCHEME, "");
  const slash = rest.search(/[/?#]/);
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  return {
    host: authority.replace(/:\d*$/, ""),
    path: slash === -1 ? "" : rest.slice(slash).replace(/[?#].*$/, ""),
  };
};

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
  const split = splitRemote(remote);
  if (split === null) return null;
  const segments = split.path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.length < 2 ? null : segments.join("/");
};

/**
 * Checks whether `remote` is a repository on github.com, so a screen draws
 * the GitHub mark beside it only when the repository really is on GitHub.
 * The host is compared without its case, and a port in a URL is ignored.
 * Returns false for a remote `isClonableRemote` refuses.
 */
export const isGitHubRemote = (remote: string): boolean =>
  splitRemote(remote)?.host.toLowerCase() === "github.com";
