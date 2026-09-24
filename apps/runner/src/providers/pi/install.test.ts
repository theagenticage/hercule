/**
 * Tests the pi install over a stubbed process seam: nothing is downloaded and
 * nothing runs. The vendor ships one install script and no way to pin a
 * release, so the install command is just that script.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makePiAdapter, type PiSeam } from "./index";

const ENV: Readonly<Record<string, string | undefined>> = { PATH: "/usr/local/bin:/usr/bin" };

const stubInstall = (answer: {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}): {
  readonly install: Effect.Effect<{ readonly ok: boolean; readonly message?: string }>;
  readonly commands: Array<ReadonlyArray<string>>;
  readonly envs: Array<Readonly<Record<string, string | undefined>>>;
} => {
  const commands: Array<ReadonlyArray<string>> = [];
  const envs: Array<Readonly<Record<string, string | undefined>>> = [];
  const seam: PiSeam = {
    // An install must not start a pi process, so the stub fails if one is
    // spawned.
    spawn: () => {
      throw new Error("an install spawns no pi");
    },
    run: (command, env) => {
      commands.push(command);
      envs.push(env);
      return Effect.succeed({
        code: answer.code,
        stdout: answer.stdout ?? "",
        stderr: answer.stderr ?? "",
      });
    },
  };
  return { install: makePiAdapter(seam).install!(ENV), commands, envs };
};

describe("installing the pi harness", () => {
  it("runs the vendor's install script", async () => {
    const { install, commands, envs } = stubInstall({ code: 0, stdout: "Installed pi" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(true);
    expect(commands).toEqual([["bash", "-c", "curl -fsSL https://pi.dev/install.sh | sh"]]);
    expect(envs).toEqual([ENV]);
  });

  it("reports the installer's own error output when it fails", async () => {
    const { install } = stubInstall({ code: 1, stderr: "install.sh: nothing was installed" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain("install.sh: nothing was installed");
  });
});
