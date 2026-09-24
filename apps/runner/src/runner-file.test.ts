/** Whether what the file holds can be dialed is the daemon's to say; `daemon.test.ts` says it. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { readRunnerFile, buildRunnerFilePath, type RunnerFile } from "./runner-file";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const ENROLLED: RunnerFile = {
  runnerId: "0199e0e7-2222-7000-8000-000000000000",
  credential: "credential-for-thalia",
  controllerUrl: "http://127.0.0.1:4937",
  controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
  controllerPublicKey: "IH5nqcbHvGUYs1n9y0sBnPGSNVYA3ZfCpZKDvXH7pqA=",
  storageDirectory: "a1b2c3d4a1b2c3d4",
};

const createHomeWithRunnerFile = (contents: Record<string, unknown>): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-runner-file-"));
  homes.push(home);
  const path = buildRunnerFilePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  return home;
};

const tryReadRunnerFile = (home: string) => Effect.runPromise(Effect.result(readRunnerFile(home)));

describe("readRunnerFile", () => {
  it("decodes the file a join wrote", async () => {
    const outcome = await tryReadRunnerFile(createHomeWithRunnerFile(ENROLLED));

    expect(outcome._tag).toBe("Success");
    expect(outcome._tag === "Success" ? outcome.success : undefined).toEqual(ENROLLED);
  });
});
