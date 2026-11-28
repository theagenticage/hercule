/**
 * `hercule measure-disk-usage <folder>`: the child process the runner walks a
 * folder in. It prints one JSON line, `{"sizeBytes":...,"freesBytes":...}`, and
 * exits 0. When the folder cannot be walked it prints the reason on stderr and
 * exits 1.
 *
 * It reads no Home and links no controller code: the dispatcher does not run
 * for this verb, `main.ts` calls it first. The runner starts it under `nice`
 * so a walk of a large `node_modules` never competes with a session.
 */
import { walkFolder } from "./walker";

/** Walks the folder named by the first argument and reports on stdout or stderr. Sets the exit code. */
export const runMeasureDiskUsage = (argv: readonly string[]): void => {
  const folder = argv[0];
  if (folder === undefined || argv.length !== 1) {
    console.error("usage: hercule measure-disk-usage <folder>");
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(walkFolder(folder)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};
