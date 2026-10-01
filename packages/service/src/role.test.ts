import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import { locateConfigFile, locateRunnerDir, locateRunnerFile } from "@hercule/home";
import { chooseServiceRole } from "./role";

let home: string;

const writeRunnerJson = (): void => {
  mkdirSync(locateRunnerDir(home), { recursive: true });
  writeFileSync(locateRunnerFile(home), "{}");
};

const writeDatabase = (dataDir: string): void => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "hercule.db"), "");
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-service-role-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("chooseServiceRole", () => {
  it("chooses serve for a Home with a controller database, even with a runner.json", async () => {
    writeDatabase(join(home, "data"));
    writeRunnerJson();
    expect(await Effect.runPromise(chooseServiceRole(home))).toEqual({
      role: "serve",
      reason: "this Home holds a controller database",
    });
  });

  it("chooses runner for a Home with a runner.json and no controller database", async () => {
    writeRunnerJson();
    expect(await Effect.runPromise(chooseServiceRole(home))).toEqual({
      role: "runner",
      reason: "this Home holds a runner.json and no controller database",
    });
  });

  it("chooses serve for a Home that holds nothing yet", async () => {
    expect(await Effect.runPromise(chooseServiceRole(home))).toEqual({
      role: "serve",
      reason: "this Home holds no runner.json",
    });
  });

  it("finds the database where config.toml puts it", async () => {
    const dataDir = join(home, "elsewhere");
    writeFileSync(locateConfigFile(home), `[data]\ndir = "${dataDir}"\n`);
    writeDatabase(dataDir);
    writeRunnerJson();
    expect((await Effect.runPromise(chooseServiceRole(home))).role).toBe("serve");
  });

  it("ignores HERCULE_DATA_DIR, because the unit runs without it", async () => {
    const dataDir = join(home, "elsewhere");
    writeDatabase(dataDir);
    writeRunnerJson();
    process.env["HERCULE_DATA_DIR"] = dataDir;
    try {
      expect((await Effect.runPromise(chooseServiceRole(home))).role).toBe("runner");
    } finally {
      delete process.env["HERCULE_DATA_DIR"];
    }
  });

  it("fails when config.toml cannot be parsed", async () => {
    writeFileSync(locateConfigFile(home), "[data\n");
    const result = await Effect.runPromise(Effect.result(chooseServiceRole(home)));
    expect(Result.isFailure(result) && result.failure._tag).toBe("ConfigFileError");
  });
});
