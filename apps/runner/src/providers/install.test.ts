/**
 * Tests installing the Claude Code harness with a stubbed process seam:
 * nothing is downloaded or run.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { CLAUDE_CODE_VERSION } from "@hercule/home/version";
import { makeClaudeCodeAdapter, type ClaudeSeam } from "./claude-code";
import type { ProviderRunnerContext } from "./index";
import { NO_CONTROLLER_TOOL_IMAGES } from "./testing";

const CONTEXT: ProviderRunnerContext = {
  cwd: null,
  attachmentsDir: null,
  toolImages: NO_CONTROLLER_TOOL_IMAGES,
  home: "/var/hercule/runner/providers/0199e0e7-0000-7000-8000-00000000000a",
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin" },
  secrets: {},
  // Not read by a probe, an install or a login. The context type requires it
  // for the sessions this adapter also hosts.
  herculeTool: { skill: "", claudePluginDir: "/var/hercule/runner/storage/claude-plugin" },
};

const buildStubSeam = (answer: {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}): { readonly seam: ClaudeSeam; readonly commands: Array<ReadonlyArray<string>> } => {
  const commands: Array<ReadonlyArray<string>> = [];
  return {
    commands,
    seam: {
      query: () => {
        throw new Error("installing must not start a query");
      },
      stream: () => {
        throw new Error("installing must not start a session");
      },
      run: (command: ReadonlyArray<string>) =>
        Effect.sync(() => {
          commands.push(command);
          return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
        }),
    },
  };
};

const formatCommand = (command: ReadonlyArray<string>): string => command.join(" ");

const install = (seam: ClaudeSeam) =>
  Effect.runPromise(makeClaudeCodeAdapter(seam).install!(CONTEXT.env));

describe("installing the Claude Code harness", () => {
  it("runs the vendor's install script, pinned to the version this build supports", async () => {
    const { seam, commands } = buildStubSeam({ code: 0, stdout: "Installed claude" });

    const outcome = await install(seam);

    expect(outcome.ok).toBe(true);
    expect(commands).toHaveLength(1);
    const written = formatCommand(commands[0]!);
    expect(written).toContain("curl -fsSL https://claude.ai/install.sh");
    // Pinned to the version this build's SDK was made for, never "latest".
    expect(written).toContain(`bash -s ${CLAUDE_CODE_VERSION}`);
  });

  it("reports the installer's own error output when it fails", async () => {
    const stderr = [
      "  % Total    % Received",
      "curl: (22) The requested URL returned error: 404",
      "install.sh: could not download the manifest",
    ].join("\n");
    const { seam } = buildStubSeam({ code: 1, stderr });

    const outcome = await install(seam);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain("install.sh: could not download the manifest");
  });
});
