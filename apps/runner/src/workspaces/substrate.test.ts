/**
 * Tests the environment the runner's git runs with. Any variable the person who
 * started the runner exported for themselves could reach a session's git, so
 * the environment is built instead of passed on.
 */
import { describe, expect, it } from "vitest";
import { buildSubstrateEnv } from "./substrate";

describe("the environment provisioning git runs with", () => {
  it("keeps ordinary variables, drops git configuration, askpass programs and Hercule's settings, and adds the runner's own", () => {
    const env = buildSubstrateEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/somebody",
        // The user's own git configuration, and two askpass programs that would
        // answer a credential prompt without going through Hercule.
        GIT_CONFIG_GLOBAL: "/home/somebody/.gitconfig",
        GIT_CONFIG_COUNT: "1",
        GIT_ASKPASS: "/usr/bin/say-the-password",
        SSH_ASKPASS: "/usr/bin/say-the-password",
        // The settings of the runner itself. A `hercule` command run by a
        // session or a setup command would act on the runner's Home.
        HERCULE_HOME: "/home/somebody/.hercule",
        HERCULE_DATA_DIR: "/mnt/hercule",
      },
      { HERCULE_RUNNER_SOCKET: "/run/hercule/daemon.sock", GIT_CONFIG_COUNT: "3" },
    );

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/somebody");
    expect(env["GIT_CONFIG_GLOBAL"]).toBeUndefined();
    expect(env["GIT_ASKPASS"]).toBeUndefined();
    expect(env["SSH_ASKPASS"]).toBeUndefined();
    expect(env["HERCULE_HOME"]).toBeUndefined();
    expect(env["HERCULE_DATA_DIR"]).toBeUndefined();
    // The runner's own variables are added after the scrub, so they are kept.
    expect(env["HERCULE_RUNNER_SOCKET"]).toBe("/run/hercule/daemon.sock");
    expect(env["GIT_CONFIG_COUNT"]).toBe("3");
    // Git on a runner never waits for a person to type a password.
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});
