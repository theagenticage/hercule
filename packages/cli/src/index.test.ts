import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import { readSetupUrl, run } from "./index";

const URL = "http://127.0.0.1:4937/setup?token=abc";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const writeSetupUrl = () => {
  writeFileSync(join(home, "setup-url"), `${URL}\n`, { mode: 0o600 });
};

describe("hydra setup-url", () => {
  it("reads the file the controller wrote, needing no credential", () => {
    writeSetupUrl();
    expect(readSetupUrl(["setup-url", "--home", home], {})).toEqual(Result.succeed(URL));
    expect(readSetupUrl(["setup-url"], { HYDRA_HOME: home })).toEqual(Result.succeed(URL));
  });

  it("says why there is nothing to print when the file is absent", () => {
    const result = readSetupUrl(["setup-url", "--home", home], {});
    expect(Result.isFailure(result) && result.failure).toContain("setup is already complete");
  });

  it("prints the URL on stdout and nothing else", () => {
    writeSetupUrl();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    run(["setup-url", "--home", home]);
    expect(log.mock.calls).toEqual([[URL]]);
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("reports an absent file on stderr and exits non-zero", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    run(["setup-url", "--home", home]);
    expect(log).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain(join(home, "setup-url"));
    expect(process.exitCode).toBe(1);
  });

  it("reports a malformed global option", () => {
    const result = readSetupUrl(["setup-url", "--home"], {});
    expect(Result.isFailure(result) && result.failure).toContain("directory");
  });
});
