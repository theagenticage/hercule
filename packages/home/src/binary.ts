/** The path prefix Bun gives the entry script inside a compiled binary. */
const BUNFS_ENTRY_PREFIX = "/$bunfs/";

/**
 * Returns the path of the compiled `hercule` binary this process runs, or
 * `undefined` when Hercule runs from a source checkout. From a checkout the
 * executable is Bun itself, which runs no Hercule without the entry script.
 */
export const locateCompiledBinary = (): string | undefined =>
  Bun.main.startsWith(BUNFS_ENTRY_PREFIX) ? process.execPath : undefined;
