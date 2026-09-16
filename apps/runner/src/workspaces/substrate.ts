/**
 * What the git substrate runs against: where it keeps things, what it remembers,
 * and the environment it hands to git and to a repository's own setup command.
 *
 * The environment is built rather than inherited: the daemon's own `GIT_*` are
 * dropped, so a `GIT_CONFIG_*` or an askpass the user exported for themselves
 * cannot reach into a workspace and answer for the agent.
 */
import type { Registry } from "./registry";
import type { GitEnv } from "./git";

/** How long a repository's setup command may run before the machine stops it. */
export const SETUP_DEADLINE_MS = 10 * 60 * 1000;

export interface Substrate {
  readonly storageDir: string;
  readonly registry: Registry;
  /** What the runner's own git runs with, before the workspace id is added. */
  readonly gitEnv: GitEnv;
  /** The same, without the provisioning claim: a setup command is repository code. */
  readonly setupEnv: GitEnv;
  readonly setupDeadlineMs: number;
}

/** What a machine's git must never take from whoever started the daemon. */
const inherited = (name: string): boolean => !name.startsWith("GIT_") && name !== "SSH_ASKPASS";

export const substrateEnv = (
  base: Readonly<Record<string, string | undefined>>,
  gitEnv?: Readonly<Record<string, string>>,
): GitEnv => ({
  ...Object.fromEntries(Object.entries(base).filter(([name]) => inherited(name))),
  ...gitEnv,
  // A machine's git never has a person at it: a prompt would hang provisioning
  // rather than fail it.
  GIT_TERMINAL_PROMPT: "0",
});
