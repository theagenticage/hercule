/**
 * Tests the sweep of token login scratch folders that a killed runner left in
 * the temp directory.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import { LOGIN_IDLE } from "./login";
import { SETUP_TOKEN_FOLDER_PREFIX, removeStaleSetupTokenFolders } from "./setup-token-folder";

const tempDirs: Array<string> = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

/** Creates a folder in `tempDir` that was last changed `ageMs` before `NOW`. */
const createFolder = (tempDir: string, name: string, ageMs: number): string => {
  const folder = join(tempDir, name);
  mkdirSync(folder);
  writeFileSync(join(folder, "state.json"), "{}");
  const changed = new Date(NOW - ageMs);
  utimesSync(folder, changed, changed);
  return folder;
};

describe("removing stale token login folders", () => {
  it("removes those older than the login idle limit and leaves younger folders and other folders", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hercule-sweep-test-"));
    tempDirs.push(tempDir);
    const idle = Duration.toMillis(LOGIN_IDLE);
    const stale = createFolder(tempDir, `${SETUP_TOKEN_FOLDER_PREFIX}old`, idle + 60_000);
    const running = createFolder(tempDir, `${SETUP_TOKEN_FOLDER_PREFIX}new`, idle - 60_000);
    const other = createFolder(tempDir, "somebody-elses-folder", idle * 10);

    removeStaleSetupTokenFolders(tempDir, NOW);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("does nothing when the temp directory cannot be read", () => {
    expect(() => {
      removeStaleSetupTokenFolders(join(tmpdir(), "hercule-sweep-test-missing"), NOW);
    }).not.toThrow();
  });
});
