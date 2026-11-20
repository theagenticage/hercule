/**
 * Starts a controller for the CLI-versus-MCP measurement in a throwaway
 * Hercule Home, signs in, writes where it listens to `<state file>`, and keeps
 * running until it gets SIGTERM. On SIGTERM it stops the controller and
 * deletes the home. It never reads or writes `~/.hercule`.
 *
 * Usage: bun docs/design/mcp/benchmark/serve.ts <state file>
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PASSWORD,
  USERNAME,
  deleteMasterKeyItem,
  findCompiledBinary,
  runCli,
  startSetUpController,
} from "../../../../scripts/controller-process";

const stateFile = process.argv[2];
if (stateFile === undefined) throw new Error("usage: serve.ts <state file>");

const home = mkdtempSync(join(tmpdir(), "hercule-mcp-bench-"));
const binary = findCompiledBinary();
const controller = await startSetUpController({ home });
const login = await runCli(
  ["login", controller.url, "--username", USERNAME, "--password-stdin", "--name", "mcp-bench"],
  { home, binary, stdin: PASSWORD },
);
if (login.code !== 0) {
  await controller.stop();
  throw new Error(`login failed:\n${login.stderr}`);
}
const { apiKey } = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as {
  apiKey: string;
};
writeFileSync(
  stateFile,
  JSON.stringify({ url: controller.url, home, apiKey, binary, pid: process.pid }, null, 2),
  { mode: 0o600 },
);
console.log(`controller at ${controller.url}, home ${home}`);

const stop = async () => {
  await controller.stop().catch(() => -1);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  deleteMasterKeyItem(home);
  rmSync(stateFile, { force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
setInterval(() => undefined, 60_000);
