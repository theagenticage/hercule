/**
 * Putting pi on a machine, over a stubbed process seam: nothing is downloaded
 * and nothing is run. The vendor ships one install script and no release pin,
 * so the command is the script and nothing else.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { piAdapter, type PiSeam } from "./index";

const ENV: Readonly<Record<string, string | undefined>> = { PATH: "/usr/local/bin:/usr/bin" };

const installing = (answer: {
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
    // An install hosts nothing: a pi spawned here would be one this case never
    // asked for, so it says so rather than starting.
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
  return { install: piAdapter(seam).install!(ENV), commands, envs };
};

describe("installing the pi harness", () => {
  it("runs the vendor's install script", async () => {
    const { install, commands, envs } = installing({ code: 0, stdout: "Installed pi" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(true);
    expect(commands).toEqual([["bash", "-c", "curl -fsSL https://pi.dev/install.sh | sh"]]);
    expect(envs).toEqual([ENV]);
  });

  it("says what the installer said when it failed, rather than that it failed", async () => {
    const { install } = installing({ code: 1, stderr: "install.sh: nothing was installed" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain("install.sh: nothing was installed");
  });
});
