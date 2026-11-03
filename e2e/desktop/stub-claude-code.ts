/**
 * A stand-in for the Claude Code CLI that `cleanup.test.ts` puts first on the
 * controller's `PATH`, so the real runner the controller starts for itself
 * hosts a Thread without a real agent. A launcher script runs it with Node,
 * which strips the types, and sets `BULK_BYTES`.
 *
 * It speaks just enough of the CLI's line protocol (the same one the runner's
 * `text-generation-claude-harness.fixture.ts` answers):
 *
 * - `--version` prints the version the build expects.
 * - A control request, such as the runner's probe of the login and the models,
 *   is answered as a signed-in account with one model.
 * - A user message makes the agent do its "work": it writes `BULK_BYTES` of
 *   data into its working directory, which is the Thread's workspace, then
 *   answers that the turn is done.
 * - It exits when the runner closes its input.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** The Claude Code release this build of Hercule expects its probe to find. */
const VERSION = "2.1.263";

/** Writes one frame of the CLI's line protocol on stdout. */
const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

const bulkBytes = Number(process.env["BULK_BYTES"]);

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const frame = JSON.parse(line) as { readonly type: string; readonly request_id?: string };
    if (frame.type === "control_request") {
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: {
            commands: [],
            output_style: "default",
            available_output_styles: ["default"],
            models: [{ value: "stub", displayName: "Stub", description: "A stand-in model" }],
            account: { email: "stub@example.test" },
          },
        },
      });
      return;
    }
    if (frame.type !== "user") return;
    writeFileSync("bulk.bin", Buffer.alloc(bulkBytes, 1));
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      modelUsage: {},
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      stop_reason: "end_turn",
    });
  })
  .on("close", () => {
    process.exit(0);
  });
