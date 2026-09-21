/**
 * The environment a machine's git runs with. Everything the person who started
 * the daemon exported for themselves is a way into a session's git, so the
 * environment is built rather than passed on.
 */
import { describe, expect, it } from "vitest";
import { substrateEnv } from "./substrate";

describe("the environment provisioning git runs with", () => {
  it("keeps the machine's own and drops what would answer for the agent", () => {
    const env = substrateEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/somebody",
        // The user's own git configuration, and the two ways a machine answers
        // a credential prompt without asking Hercule.
        GIT_CONFIG_GLOBAL: "/home/somebody/.gitconfig",
        GIT_CONFIG_COUNT: "1",
        GIT_ASKPASS: "/usr/bin/say-the-password",
        SSH_ASKPASS: "/usr/bin/say-the-password",
      },
      { HERCULE_RUNNER_SOCKET: "/run/hercule/daemon.sock", GIT_CONFIG_COUNT: "3" },
    );

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/somebody");
    expect(env["GIT_CONFIG_GLOBAL"]).toBeUndefined();
    expect(env["GIT_ASKPASS"]).toBeUndefined();
    expect(env["SSH_ASKPASS"]).toBeUndefined();
    // Hercule's own pairs survive the scrub, because they are added after it.
    expect(env["HERCULE_RUNNER_SOCKET"]).toBe("/run/hercule/daemon.sock");
    expect(env["GIT_CONFIG_COUNT"]).toBe("3");
    // Nothing on a machine waits for a person to type a password.
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});
