/**
 * A stand-in for the Claude Code CLI, started by the real SDK in
 * `text-generation.integration.test.ts`. It speaks just enough of the CLI's
 * line protocol for a text generation, and it lets the test choose how the
 * process behaves when it is asked to stop. Settings come from the
 * environment:
 *
 * - `HARNESS_PROOF_DIR`: where the process writes `pid-<pid>` and
 *   `cwd-<pid>`, so the test can check whether the process still runs and
 *   where it ran.
 * - `HARNESS_ANSWER`: `submit` answers the user message with a valid result;
 *   `silent` never answers; `crash` writes a line to its error output and
 *   exits with code 3 on the user message.
 * - `HARNESS_ON_STDIN_END`: `exit` exits when its stdin closes, like the real
 *   CLI; `ignore` keeps running, like a CLI that hangs while shutting down.
 *
 * It always ignores SIGTERM, so only SIGKILL ends a process that stays.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const proofDir = process.env["HARNESS_PROOF_DIR"] ?? "";
const pid = String(process.pid);
writeFileSync(join(proofDir, `pid-${pid}`), pid);
writeFileSync(join(proofDir, `cwd-${pid}`), process.cwd());
writeFileSync(
  join(proofDir, `launch-${pid}`),
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    configDir: process.env["CLAUDE_CONFIG_DIR"],
    autoMemoryDisabled: process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"],
  }),
);

process.on("SIGTERM", () => undefined);

// Keeps the process alive when stdin closes.
const alive = setInterval(() => undefined, 1000);

const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const input = createInterface({ input: process.stdin });
input.on("close", () => {
  if (process.env["HARNESS_ON_STDIN_END"] === "exit") {
    clearInterval(alive);
    process.exit(0);
  }
});
input.on("line", (line) => {
  const frame = JSON.parse(line) as { readonly type: string; readonly request_id?: string };
  if (frame.type === "control_request") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: frame.request_id, response: {} },
    });
    return;
  }
  if (frame.type === "user" && process.env["HARNESS_ANSWER"] === "crash") {
    process.stderr.write("fixture harness: not logged in\n");
    process.exit(3);
  }
  if (frame.type !== "user" || process.env["HARNESS_ANSWER"] !== "submit") return;
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: { title: "A valid title" },
    modelUsage: {},
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0,
    stop_reason: "end_turn",
  });
});
