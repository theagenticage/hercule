import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCredential, createHarnessHome, formatModelArgument } from "./account";

const scratch: Array<string> = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the Harness Home on this machine", () => {
  it("is the folder the controller named under the storage directory, private to the user", () => {
    const storage = mkdtempSync(join(tmpdir(), "hercule-home-"));
    scratch.push(storage);
    const home = createHarnessHome(storage, "providers/homes/acct-1/pi/pi");
    expect(home).toBe(join(storage, "providers", "homes", "acct-1", "pi", "pi"));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // A second call finds the folder and keeps it.
    expect(createHarnessHome(storage, "providers/homes/acct-1/pi/pi")).toBe(home);
  });
});

describe("the model argument", () => {
  it("puts the model id where the placeholder is", () => {
    expect(formatModelArgument("{model}", "haiku")).toBe("haiku");
    expect(formatModelArgument("zai/{model}", "glm-5.3")).toBe("zai/glm-5.3");
  });

  it("keeps a model id that looks like a replacement pattern as it is", () => {
    expect(formatModelArgument("zai/{model}", "a$&b")).toBe("zai/a$&b");
  });
});

describe("the credential in the environment", () => {
  const credentialVariables = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

  it("sets the variable the account names, over the same variable of the runner", () => {
    const env = applyCredential(
      { PATH: "/bin", ANTHROPIC_API_KEY: "the-runners-own" },
      {
        credentialVariables,
        credential: { variable: "ANTHROPIC_API_KEY", value: "the-accounts" },
      },
    );
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "the-accounts" });
  });

  it("removes every credential variable of the harness, so none of the runner's own stands in", () => {
    const env = applyCredential(
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "the-runners-own",
        CLAUDE_CODE_OAUTH_TOKEN: "the-runners-token",
      },
      { credentialVariables },
    );
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("removes the variables the credential does not use when it sets the one it does", () => {
    const env = applyCredential(
      { ANTHROPIC_API_KEY: "the-runners-own", CLAUDE_CODE_OAUTH_TOKEN: "the-runners-token" },
      {
        credentialVariables,
        credential: { variable: "CLAUDE_CODE_OAUTH_TOKEN", value: "the-accounts-token" },
      },
    );
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "the-accounts-token" });
  });

  it("leaves the environment as it is when the harness has no credential variables, and never changes the given object", () => {
    const original = { PATH: "/bin", ANTHROPIC_API_KEY: "kept" };
    const env = applyCredential(original, { credentialVariables: [] });
    expect(env).toEqual(original);
    expect(env).not.toBe(original);
    applyCredential(original, { credentialVariables });
    expect(original).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "kept" });
  });
});
