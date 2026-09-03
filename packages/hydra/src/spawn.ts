import { spawn, type ChildProcess } from "node:child_process";

/**
 * Start another role of this same binary.
 *
 * `process.execPath` is the compiled executable, so this is the only way a
 * Hydra process starts another one: `child_process.fork()` and `cluster.fork()`
 * are broken under `bun build --compile`, and the binary must never shell out
 * to a literal `bun` (spec 15 section 11).
 */
export function spawnHydra(args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [...args], { stdio: "inherit" });
}
