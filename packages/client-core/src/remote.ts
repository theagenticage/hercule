/**
 * Whether a remote is one Hercule will hand to git, asked before the form is
 * sent so the user is told on the spot rather than by a round trip (D-20b).
 *
 * The rule is the controller's `isClonableRemote` (`apps/controller/src/
 * resources/remote.ts`), which stays the one that decides: this refuses early,
 * it refuses finally. The two are the same three sentences - an `https://` URL
 * or git's own `user@host:owner/repo`, and never a word git would read as an
 * option - so a spelling that passes here is one the controller takes.
 */

/** What git reads as an option rather than as a remote. */
const OPTION = /^-/;

/** `scheme://` at the front, which tells a URL from git's scp-like spelling. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** `user@host:path`, git's own spelling, which carries no scheme. */
const SCP = /^[^@/]+@[^@/:]+:[^:]+$/;

export const isClonableRemote = (remote: string): boolean => {
  const written = remote.trim();
  if (written.length === 0 || OPTION.test(written)) return false;
  const scheme = SCHEME.exec(written);
  return scheme === null ? SCP.test(written) : scheme[0].toLowerCase() === "https://";
};

/** What the form says when it refuses one, naming both spellings it takes. */
export const REMOTE_REFUSAL = "Write an https:// URL or git@host:owner/repo";
