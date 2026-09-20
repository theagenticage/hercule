import { spawn, type ChildProcess } from "node:child_process";

/**
 * Start another role of this same binary.
 *
 * `process.execPath` is the compiled executable, so this is the only way a
 * Hercule process starts another one: `child_process.fork()` and `cluster.fork()`
 * are broken under `bun build --compile`, and the binary must never shell out
 * to a literal `bun`.
 */
export function spawnHercule(args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [...args], { stdio: "inherit" });
}
