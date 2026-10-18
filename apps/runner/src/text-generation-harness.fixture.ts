/**
 * A stand-in for the pi harness, run as a real child process by
 * `text-generation.integration.test.ts`. It speaks just enough of pi's line
 * protocol for a text generation, and it lets the test choose how the process
 * behaves when it is asked to stop. Settings come from the environment:
 *
 * - `HARNESS_PROOF_DIR`: where the process writes `pid-<pid>`, so the test can
 *   check whether the process still runs.
 * - `HARNESS_ANSWER`: `submit` answers the prompt with a valid result;
 *   `silent` never answers.
 * - `HARNESS_ON_SIGTERM`: `ignore` keeps running after SIGTERM, so only
 *   SIGKILL ends it; a number of milliseconds exits after that long, like a
 *   harness with cleanup work to finish.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Installed first, so a SIGTERM that arrives while the process is still
// starting gets the behaviour the test chose, not the default exit.
const onSigterm = process.env["HARNESS_ON_SIGTERM"] ?? "ignore";
process.on("SIGTERM", () => {
  if (onSigterm === "ignore") return;
  setTimeout(() => process.exit(0), Number(onSigterm));
});

const proofDir = process.env["HARNESS_PROOF_DIR"] ?? "";
writeFileSync(join(proofDir, `pid-${String(process.pid)}`), String(process.pid));

// Keeps the process alive when stdin closes.
setInterval(() => undefined, 1000);

const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line) as { readonly id: string; readonly type: string };
  send({ type: "response", id: command.id, command: command.type, success: true });
  if (command.type !== "prompt" || process.env["HARNESS_ANSWER"] !== "submit") return;
  send({ type: "agent_start" });
  send({
    type: "tool_execution_start",
    toolCallId: "call-submit",
    toolName: "submit_result",
    args: { title: "A valid title" },
  });
  send({
    type: "tool_execution_end",
    toolCallId: "call-submit",
    toolName: "submit_result",
    result: { content: [{ type: "text", text: "Recorded." }] },
  });
  send({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  });
  send({ type: "agent_settled" });
});
