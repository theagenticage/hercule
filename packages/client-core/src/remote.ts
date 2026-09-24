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
