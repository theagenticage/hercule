/**
 * The shared state the workspace code runs with: the storage directory, the
 * registry, and the environment passed to git and, without the credential
 * socket, to a repository's setup command.
 *
 * The environment is built, not inherited. The runner's own `GIT_*` variables
 * are dropped, so a `GIT_CONFIG_*` or an askpass program the user exported for
 * their own shell cannot reach into a workspace and supply credentials for the
 * agent. The runner's own `HERCULE_*` variables are dropped too, so a session
 * or a setup command never gets the runner's Home or settings.
 */
import type { Registry } from "./registry";
import type { GitEnv } from "./git";

/** How long a repository's setup command may run before the runner stops it. */
export const SETUP_DEADLINE_MS = 10 * 60 * 1000;

export interface Substrate {
  readonly storageDir: string;
  readonly registry: Registry;
  readonly coordinateRepository: <A>(key: string, work: () => Promise<A>) => Promise<A>;
  /**
   * The environment for the runner's own git, and the base of a repository's
   * setup command's environment. While provisioning, the runner adds the
   * workspace id to it for git, so the credential helper can get a
   * credential. A setup command gets this environment without the credential
   * socket, so the credential helper git is configured with answers nothing
   * there: a setup command is repository code.
   */
  readonly gitEnv: GitEnv;
  readonly setupDeadlineMs: number;
}

/**
 * Checks whether a variable is passed on from the runner's own environment.
 * These are not:
 *
 * - `GIT_*` and `SSH_ASKPASS`, because git must never take them from whoever
 *   started the runner.
 * - `HERCULE_*`, because they configure the runner itself. On the local runner
 *   `HERCULE_HOME` is the user's live Home, and a `hercule serve` run inside a
 *   session would open its database. The variables a child needs, such as a
 *   session's `HERCULE_TOKEN`, are added after this filter.
 */
const isInherited = (name: string): boolean =>
  !name.startsWith("GIT_") && !name.startsWith("HERCULE_") && name !== "SSH_ASKPASS";

export const buildSubstrateEnv = (
  base: Readonly<Record<string, string | undefined>>,
  gitEnv?: Readonly<Record<string, string>>,
): GitEnv => ({
  ...Object.fromEntries(Object.entries(base).filter(([name]) => isInherited(name))),
  ...gitEnv,
  // Nobody is at a terminal to answer git on a runner, so a prompt would hang
  // provisioning instead of failing it.
  GIT_TERMINAL_PROMPT: "0",
});
