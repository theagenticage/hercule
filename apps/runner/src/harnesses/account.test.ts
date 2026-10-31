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
  it("sets the variable the account names, over the same variable of the runner", () => {
    const env = applyCredential(
      { PATH: "/bin", ZAI_API_KEY: "the-runners-own" },
      { variable: "ZAI_API_KEY", value: "the-accounts" },
    );
    expect(env).toEqual({ PATH: "/bin", ZAI_API_KEY: "the-accounts" });
  });

  it("removes the variable for an account that has none, so the runner's own key never stands in", () => {
    const env = applyCredential(
      { PATH: "/bin", ZAI_API_KEY: "the-runners-own" },
      { variable: "ZAI_API_KEY" },
    );
    expect(env).toEqual({ PATH: "/bin" });
    expect("ZAI_API_KEY" in env).toBe(false);
  });

  it("changes nothing for an account without a credential, and never the given object", () => {
    const original = { PATH: "/bin" };
    const env = applyCredential(original, undefined);
    expect(env).toEqual({ PATH: "/bin" });
    expect(env).not.toBe(original);
    applyCredential(original, { variable: "KEY", value: "v" });
    expect(original).toEqual({ PATH: "/bin" });
  });
});
