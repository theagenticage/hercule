// Signs a fresh home in. Usage: bun login.ts <home>
// Prints the sign-in link, then waits (up to 30 min) for a code in <home>.code, feeds it to agy.
// Never prints the token file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AGY_BINARY } from "./agy-session.ts";

const home = process.argv[2];
if (!home) { console.error("usage: bun login.ts <home>"); process.exit(2); }
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(join(home, "antigravity-acp"), { recursive: true, mode: 0o700 });
const logFolder = mkdtempSync(join(home, "login-log-"));

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(GEMINI_|GOOGLE_|AGY_)/.test(k)) env[k] = v;
env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";
env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";

const child = Bun.spawn(
  [AGY_BINARY, "acp", "--login", "--gemini-dir", home, "--app-data-dir", "antigravity-acp", "--log-file", join(logFolder, "agy.log")],
  { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);
let lastLine = "";
let exited = false;
const pump = async (stream: ReadableStream<Uint8Array>, tag: string) => {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    if (line.trim() === "") return;
    if (tag === "out") lastLine = line;
    console.log(`[agy ${tag}] ${line}`);
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) { flush(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
  }
  flush(buffer);
};
const pumps = Promise.all([pump(child.stdout, "out"), pump(child.stderr, "err")]);
void child.exited.then(() => { exited = true; });

const codeFile = `${home}.code`;
console.log(`waiting for a code in ${codeFile} (up to 30 minutes)`);
const deadline = Date.now() + 30 * 60_000;
let sent = false;
while (!exited && Date.now() < deadline) {
  if (!sent && existsSync(codeFile)) {
    const code = readFileSync(codeFile, "utf8").trim();
    if (code !== "") {
      child.stdin.write(`${code}\n`);
      child.stdin.flush();
      sent = true;
      rmSync(codeFile, { force: true });
      console.log("code sent to agy");
    }
  }
  await Bun.sleep(1000);
}
if (!exited) { console.log("timed out; stopping agy"); child.kill("SIGTERM"); }
const code = await child.exited;
await pumps;
rmSync(logFolder, { recursive: true, force: true });
console.log(`agy exit code: ${code}`);
console.log(`last stdout line: ${lastLine}`);
process.exit(code === 0 ? 0 : 1);
