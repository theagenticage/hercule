/**
 * How the CLI ends, by class of failure.
 *
 * The codes are part of the CLI's contract with the scripts and agents that
 * drive it, so they are named here and printed by `hercule --help`: a caller can
 * retry a connection failure and must not retry a usage error.
 */
export const EXIT = {
  /** The operation succeeded. */
  ok: 0,
  /**
   * The controller answered with the error envelope, or a check of a
   * workflow found an error.
   */
  api: 1,
  /** The command line was wrong: unknown command, missing argument, bad value. */
  usage: 2,
  /**
   * The controller could not be reached, or the local state this command needs
   * is missing: no credential resolved, no setup URL written.
   */
  connection: 3,
} as const;

/** The command line was wrong. Nothing was sent. */
export class UsageError extends Error {
  override readonly name = "UsageError";
  /** What `--help` to suggest, e.g. `profile create`; absent for a top-level mistake. */
  readonly help: string | undefined;

  constructor(message: string, help?: string) {
    super(message);
    this.help = help;
  }
}
