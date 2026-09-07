/**
 * Installing the Claude Code harness on the machine the runner is on.
 *
 * The installer is a shell pipeline that downloads and runs somebody else's
 * script, so it is reached through the same injected process seam the probe
 * uses: this file states which command the adapter runs and what it makes of an
 * installer that failed, without either downloading or running anything.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import { claudeCodeAdapter, type ClaudeSeam } from "./claude-code";
import type { ProviderRunnerContext } from "./index";

const CONTEXT: ProviderRunnerContext = {
  home: "/var/hydra/runner/providers/0199e0e7-0000-7000-8000-00000000000a",
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin" },
};

/** A seam whose `run` answers with an exit and records the command it was given. */
const seamRunning = (answer: {
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
      run: (command: ReadonlyArray<string>) =>
        Effect.sync(() => {
          commands.push(command);
          return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
        }),
    },
  };
};

/** The command as a shell would read it, which is what the criterion names. */
const asWritten = (command: ReadonlyArray<string>): string => command.join(" ");

const install = (seam: ClaudeSeam) =>
  Effect.runPromise(claudeCodeAdapter(seam).install!(CONTEXT.env));

describe("installing the Claude Code harness", () => {
  it("runs the vendor's install script pinned to the version this build talks to", async () => {
    const { seam, commands } = seamRunning({ code: 0, stdout: "Installed claude" });

    const outcome = await install(seam);

    expect(outcome.ok).toBe(true);
    expect(commands).toHaveLength(1);
    const written = asWritten(commands[0]!);
    expect(written).toContain("curl -fsSL https://claude.ai/install.sh");
    // Pinned to the floor: the version the SDK in this binary was built
    // against, never "latest", or a machine could end up on a CLI this build
    // has never talked to.
    expect(written).toContain(`bash -s ${CLAUDE_CODE_VERSION}`);
  });

  it("says what the installer said when it failed, rather than that it failed", async () => {
    const stderr = [
      "  % Total    % Received",
      "curl: (22) The requested URL returned error: 404",
      "install.sh: could not download the manifest",
    ].join("\n");
    const { seam } = seamRunning({ code: 1, stderr });

    const outcome = await install(seam);

    expect(outcome.ok).toBe(false);
    // The operator reads the installer's own words: "the install failed" is
    // not something anybody can act on.
    expect(outcome.message ?? "").toContain("install.sh: could not download the manifest");
  });
});
