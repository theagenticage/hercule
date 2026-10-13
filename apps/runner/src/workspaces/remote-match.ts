/**
 * Decides whether a checkout's Git remote and a resource's remote are the same
 * repository, when they may be spelled with different host names.
 *
 * `canonicalizeRemote` only rewrites text, so it cannot know that the host in
 * `git@work-github:Acme/web.git` is an alias from the user's `~/.ssh/config`
 * that points at `github.com`. Only this machine knows that, which is why the
 * comparison lives in the runner.
 *
 * When the two remotes are written with different hosts, the result must be
 * what git itself would connect to. So:
 *
 * - Only SSH remotes are resolved through the SSH configuration. Git reaches an
 *   HTTPS remote without SSH, so a `HostName` line says nothing about where an
 *   HTTPS remote leads.
 * - `ssh -G` gets the user and port written in the remote, because a `Match
 *   user` block can change the host name.
 * - `ssh -G` runs in the checkout's directory, because git starts `ssh` there
 *   and a `Match exec` rule can depend on the working directory.
 *
 * Two decisions keep this safe and cheap:
 *
 * - When both remotes are written with the same host, they are taken to be the
 *   same repository without asking SSH. Asking would start `ssh` for every
 *   ordinary `git@github.com:...` checkout on every check, and would reject it
 *   on a machine without `ssh`. Only a spelling that differs needs the SSH
 *   configuration to be reconciled. A user who points `github.com` at another
 *   host in their own SSH configuration has chosen that redirect.
 * - When a host that is needed to compare different spellings cannot be
 *   resolved (no `ssh`, a failure, or no answer within the deadline), the
 *   remotes do not match. A host that could not be established is never
 *   compared as written, because it could then equal another remote's
 *   resolved host and match a different repository.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { canonicalizeRemote } from "@hercule/protocol";
import { runCommand, type GitEnv } from "./git";

/**
 * How long `ssh -G` may run before the runner gives up on resolving a host.
 * Evaluating an SSH configuration can run commands (`Match exec`) and do DNS
 * lookups, so it has no natural bound.
 */
export const SSH_RESOLVE_DEADLINE: Duration.Duration = Duration.seconds(5);

/** What SSH is asked to connect to: the user and port are part of which settings apply. */
interface SshDestination {
  readonly user: string | undefined;
  readonly host: string;
  readonly port: string | undefined;
}

/** `scheme://` at the start, which tells a URL apart from git's scp-like form. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** The URL schemes git runs over SSH. */
const SSH_SCHEME = /^(?:ssh|git\+ssh|ssh\+git):\/\//i;

/** An SSH URL with an optional user, a host (an IPv6 address is in brackets) and an optional port. */
const SSH_URL =
  /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/@]+)(?::(\d+))?(?:\/|$)/i;

/** Git's scp-like form, `[user@]host:path`, where the colon comes before any slash. */
const SCP_LIKE = /^(?:([^@/:]+)@)?([^@/:]+):/;

/**
 * Returns the SSH destination a remote connects to, or `undefined` when the
 * remote is not reached over SSH (HTTPS, `git://`, a local path) or its SSH
 * destination cannot be read. The host of an IPv6 address is returned without
 * its brackets, the way git passes it to `ssh`.
 */
const parseSshDestination = (remote: string): SshDestination | undefined => {
  const written = remote.trim();
  const found = SCHEME.test(written) ? SSH_URL.exec(written) : SCP_LIKE.exec(written);
  if (found === null) return undefined;
  const [, user, host, port] = found;
  if (host === undefined) return undefined;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  return bare.startsWith("-") ? undefined : { user, host: bare.toLowerCase(), port };
};

/**
 * Returns the host name `ssh -G` reports for a destination, in lower case, as
 * it appears in a canonical remote (an IPv6 address is in brackets). Returns
 * `undefined` when `ssh` is not installed, fails, or does not answer within
 * `SSH_RESOLVE_DEADLINE`.
 *
 * `ssh -G` opens no connection and only prints the settings that apply, but
 * evaluating them can run commands, so it is bounded by a deadline and runs in
 * `cwd`, the directory git would start `ssh` in.
 */
const resolveSshHostname = (
  destination: SshDestination,
  env: GitEnv,
  cwd: string,
): Effect.Effect<string | undefined> => {
  const target =
    destination.user === undefined ? destination.host : `${destination.user}@${destination.host}`;
  const args = [
    "-G",
    ...(destination.port === undefined ? [] : ["-p", destination.port]),
    "--",
    target,
  ];
  return runCommand("ssh", args, { env, cwd }).pipe(
    Effect.timeoutOption(SSH_RESOLVE_DEADLINE),
    Effect.map((outcome) => {
      if (Option.isNone(outcome) || !outcome.value.ok) return undefined;
      const line = outcome.value.stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("hostname "));
      const hostname = line?.slice("hostname ".length).trim().toLowerCase();
      if (hostname === undefined || hostname === "") return undefined;
      return hostname.includes(":") ? `[${hostname}]` : hostname;
    }),
    Effect.orElseSucceed(() => undefined),
  );
};

/**
 * Returns the canonical form of a remote with the host an SSH remote connects
 * to in place of the host written in it. A remote that is not reached over SSH
 * keeps its canonical form. Returns `undefined` when the text is not a remote,
 * or when it is an SSH remote whose host could not be read or resolved.
 */
const canonicalizeResolved = (
  remote: string,
  env: GitEnv,
  cwd: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const canonical = canonicalizeRemote(remote);
    if (canonical === undefined) return undefined;
    const destination = parseSshDestination(remote);
    // A remote with an SSH scheme whose destination cannot be read is still an
    // SSH remote. Its written host is unverified, so it must not be compared.
    if (destination === undefined) return SSH_SCHEME.test(remote.trim()) ? undefined : canonical;
    const hostname = yield* resolveSshHostname(destination, env, cwd);
    return hostname === undefined
      ? undefined
      : `${hostname}${canonical.slice(canonical.indexOf("/"))}`;
  });

/**
 * Checks whether two remotes name the same repository. Returns `false` when
 * either one is not a valid remote.
 *
 * The canonical forms are compared first, which costs nothing. Only when they
 * differ is each SSH remote resolved through the SSH configuration (and the
 * remotes do not match if one of them cannot be resolved), so a
 * checkout using the SSH alias `work-github` still matches a resource using
 * `https://github.com/...`, and the common case starts no process. `cwd` is
 * the root of the checkout, where git starts `ssh`.
 */
export const isSameRepository = (
  firstRemote: string,
  secondRemote: string,
  env: GitEnv,
  cwd: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const first = canonicalizeRemote(firstRemote);
    const second = canonicalizeRemote(secondRemote);
    if (first === undefined || second === undefined) return false;
    if (first === second) return true;
    const [resolvedFirst, resolvedSecond] = yield* Effect.all([
      canonicalizeResolved(firstRemote, env, cwd),
      canonicalizeResolved(secondRemote, env, cwd),
    ]);
    return resolvedFirst !== undefined && resolvedFirst === resolvedSecond;
  });

/**
 * Returns a remote as shown in a message: `host/owner/repo`. Everything that
 * can carry a secret is left out: a user name or password, a port, and any
 * query string or fragment. Returns `undefined` when nothing is left that
 * identifies a repository.
 */
const formatRemoteForDisplay = (remote: string): string | undefined =>
  canonicalizeRemote(remote.replace(/[?#].*$/s, ""));

/**
 * Builds the error text for a checkout whose remote is not the resource's
 * repository. It names both repositories as `host/owner/repo`, so the user can
 * see what differs, and repeats no user name, password, query string or
 * fragment from either remote.
 */
export const describeRemoteMismatch = (
  remoteName: string,
  checkoutRemote: string,
  resourceRemote: string,
): string => {
  const checkout = formatRemoteForDisplay(checkoutRemote) ?? "an unrecognized address";
  const resource = formatRemoteForDisplay(resourceRemote) ?? "an unrecognized address";
  return (
    `The selected checkout's remote "${remoteName}" points to ${checkout}, ` +
    `but the resource repository is ${resource}. ` +
    "Choose a checkout of the resource repository, or choose another of its remotes. " +
    "An SSH host alias counts as the host it connects to."
  );
};
