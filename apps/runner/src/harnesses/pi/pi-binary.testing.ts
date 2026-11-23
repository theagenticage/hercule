import { dirname } from "node:path";

/**
 * Finds the pi binary the real-pi MCP tests run against. Returns the path in
 * `HERCULE_PI_TEST_BINARY` when it is set, so a test can use a pinned release
 * without changing `PATH`, and otherwise the `pi` on `PATH`. Returns
 * `undefined` when there is neither, and those tests skip.
 */
export const findPiTestBinary = (): string | undefined =>
  process.env["HERCULE_PI_TEST_BINARY"] ?? Bun.which("pi") ?? undefined;

/**
 * Builds the `PATH` a test gives a real pi, from nothing of the developer's
 * own: the folder of the pi binary, the folder of `node` (an npm-installed pi
 * is a script that runs it), and the system folders that hold the shell pi
 * runs its commands with. No folder of a Hercule Home is on it, so a pi under
 * test can never start the user's own `hercule`.
 */
export const buildPiTestPath = (binary: string): string => {
  const node = Bun.which("node");
  return [dirname(binary), ...(node === null ? [] : [dirname(node)]), "/usr/bin", "/bin"].join(":");
};
