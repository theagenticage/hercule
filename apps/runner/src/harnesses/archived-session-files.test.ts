/**
 * Tests for deleting the harness files of archived sessions, through the one
 * batch function: the files go, a home that leads outside the storage
 * directory is never followed, and what stays becomes one warning per harness
 * that names the harness as the user knows it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchivedSession } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { deleteArchivedSessionFiles } from "./archived-session-files";
import { CLAUDE_CODE } from "./claude-code";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const HOME = "providers/homes/account-1/anthropic/claude";

const buildSession = (overrides: Partial<ArchivedSession> = {}): ArchivedSession => ({
  harnessId: CLAUDE_CODE,
  harnessHome: HOME,
  nativeSessionId: SESSION_ID,
  ...overrides,
});

const temporaries: Array<string> = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) {
    // A test may leave a folder unreadable, which `rm` cannot remove.
    try {
      chmodSync(join(path, "providers"), 0o700);
    } catch {
      // The folder is not there.
    }
    rmSync(path, { recursive: true, force: true });
  }
});

const createStorageDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "archived-session-files-"));
  temporaries.push(path);
  return path;
};

/** Writes a Claude Code transcript below `home` and returns its path. */
const createTranscript = (home: string, nativeSessionId = SESSION_ID): string => {
  mkdirSync(join(home, "projects", "-work"), { recursive: true });
  const transcript = join(home, "projects", "-work", `${nativeSessionId}.jsonl`);
  writeFileSync(transcript, "{}");
  return transcript;
};

const run = (storageDir: string, sessions: ReadonlyArray<ArchivedSession>) =>
  Effect.runPromise(deleteArchivedSessionFiles(storageDir, sessions));

describe("deleteArchivedSessionFiles", () => {
  it("deletes the files of a home that is a real folder, and returns no warning", async () => {
    const storageDir = createStorageDir();
    const transcript = createTranscript(join(storageDir, HOME));

    const warnings = await run(storageDir, [buildSession()]);

    expect(warnings).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
  });

  it("succeeds when the home is not there", async () => {
    expect(await run(createStorageDir(), [buildSession()])).toEqual([]);
  });

  it("names a harness this runner has no adapter for by its id", async () => {
    const warnings = await run(createStorageDir(), [
      buildSession({ harnessId: "unknown:harness" }),
    ]);

    expect(warnings).toEqual([
      "unknown:harness kept the files of 1 session: this runner has no adapter for the harness",
    ]);
  });

  it("names the harness as the user knows it, and ends the reason without a period", async () => {
    const storageDir = createStorageDir();
    mkdirSync(join(storageDir, HOME), { recursive: true });

    // Not a valid id, which every adapter refuses.
    const warnings = await run(storageDir, [buildSession({ nativeSessionId: "../escape" })]);

    expect(warnings).toEqual([
      "Claude Code kept the files of 1 session: the session id is not valid",
    ]);
  });

  it("returns one warning per harness, counts its sessions, and still deletes the other sessions' files", async () => {
    const storageDir = createStorageDir();
    const transcript = createTranscript(join(storageDir, HOME), OTHER_ID);

    const warnings = await run(storageDir, [
      buildSession({ nativeSessionId: "../one" }),
      buildSession({ nativeSessionId: "../two" }),
      buildSession({ nativeSessionId: OTHER_ID }),
    ]);

    expect(warnings).toEqual([
      "Claude Code kept the files of 2 sessions: the session id is not valid",
    ]);
    expect(existsSync(transcript)).toBe(false);
  });

  it("keeps the files and says why when the home is a symbolic link", async () => {
    const storageDir = createStorageDir();
    const external = createStorageDir();
    const transcript = createTranscript(external);
    mkdirSync(join(storageDir, "providers/homes/account-1/anthropic"), { recursive: true });
    symlinkSync(external, join(storageDir, HOME));

    const warnings = await run(storageDir, [buildSession()]);

    expect(warnings).toEqual([
      "Claude Code kept the files of 1 session: its home is not a folder inside the runner's storage",
    ]);
    expect(existsSync(transcript)).toBe(true);
  });

  it("keeps the files when a folder above the home is a symbolic link", async () => {
    const storageDir = createStorageDir();
    const external = createStorageDir();
    const transcript = createTranscript(join(external, "anthropic", "claude"));
    mkdirSync(join(storageDir, "providers/homes"), { recursive: true });
    symlinkSync(external, join(storageDir, "providers/homes/account-1"));

    const warnings = await run(storageDir, [buildSession()]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/its home is not a folder inside the runner's storage$/);
    expect(existsSync(transcript)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the files and gives the plain reason when the home cannot be read",
    async () => {
      const storageDir = createStorageDir();
      mkdirSync(join(storageDir, HOME), { recursive: true });
      chmodSync(join(storageDir, "providers"), 0o000);

      const warnings = await run(storageDir, [buildSession()]);

      expect(warnings).toEqual([
        "Claude Code kept the files of 1 session: its home cannot be read: permission denied",
      ]);
    },
  );
});
