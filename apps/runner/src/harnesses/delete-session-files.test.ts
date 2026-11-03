/**
 * Tests `deleteSessionFiles` of the three adapters against a Harness Home laid
 * out the way each harness lays out its files.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { pi } from "./pi";
import type { HarnessAdapter } from "./index";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    // A test may leave a folder read-only, which `rm` cannot remove.
    chmodTree(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

const chmodTree = (path: string, mode: number): void => {
  try {
    chmodSync(path, mode);
    for (const name of readdirSync(path)) chmodTree(join(path, name), mode);
  } catch {
    // A file or a path that is already gone needs no change.
  }
};

const createHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "harness-home-"));
  homes.push(home);
  return home;
};

/** Writes an empty file, creating the folders above it. */
const createFile = (...path: ReadonlyArray<string>): string => {
  const file = join(...path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{}");
  return file;
};

const deleteFiles = (adapter: HarnessAdapter, home: string, nativeSessionId: string) =>
  Effect.runPromise(adapter.deleteSessionFiles(home, nativeSessionId));

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("Claude Code deleteSessionFiles", () => {
  it("deletes the transcript, its sidecar folder and the session's own folders, in every project", async () => {
    const home = createHome();
    const own = [
      createFile(home, "projects", "-work-a", `${SESSION}.jsonl`),
      createFile(home, "projects", "-work-a", SESSION, "subagents", "agent-1.jsonl"),
      createFile(home, "projects", "-work-b", `${SESSION}.jsonl`),
      createFile(home, "session-env", SESSION, "env.json"),
      createFile(home, "file-history", SESSION, "abc@v1"),
    ];
    const others = [
      createFile(home, "projects", "-work-a", `${OTHER}.jsonl`),
      createFile(home, "projects", "-work-a", OTHER, "tool-results", "r.txt"),
      createFile(home, "session-env", OTHER, "env.json"),
      createFile(home, "file-history", OTHER, "abc@v1"),
      createFile(home, "settings.json"),
    ];

    await deleteFiles(claudeCode, home, SESSION);

    expect(own.filter(existsSync)).toEqual([]);
    expect(others.filter((file) => !existsSync(file))).toEqual([]);
    // The folders the session's files sat in are kept: other sessions use them.
    expect(existsSync(join(home, "projects", "-work-a"))).toBe(true);
  });

  it("succeeds for a session with no files, and for a home with no projects folder", async () => {
    const home = createHome();
    createFile(home, "projects", "-work-a", `${OTHER}.jsonl`);
    await deleteFiles(claudeCode, home, SESSION);
    await deleteFiles(claudeCode, createHome(), SESSION);
  });

  it("refuses an id that would leave the Harness Home, and deletes nothing", async () => {
    const home = createHome();
    const file = createFile(home, "session-env", "keep", "env.json");
    const error = await Effect.runPromise(
      Effect.flip(claudeCode.deleteSessionFiles(join(home, "projects"), "../session-env/keep")),
    );
    expect(error._tag).toBe("AdapterFailed");
    expect(existsSync(file)).toBe(true);
  });

  // A root user can delete inside a read-only folder.
  it.skipIf(process.getuid?.() === 0)(
    "fails with the reason when a file cannot be deleted",
    async () => {
      const home = createHome();
      createFile(home, "projects", "-work-a", `${SESSION}.jsonl`);
      chmodSync(join(home, "projects", "-work-a"), 0o500);

      const error = await Effect.runPromise(
        Effect.flip(claudeCode.deleteSessionFiles(home, SESSION)),
      );

      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toMatch(/permission denied/i);
      expect(error.message).not.toContain(home);
    },
  );
});

describe("Codex deleteSessionFiles", () => {
  it("deletes the session's rollout in any date folder and leaves other rollouts and shared files", async () => {
    const home = createHome();
    const sessions = join(home, "codex", "sessions");
    const own = [
      createFile(sessions, "2026", "10", "12", `rollout-2026-10-12T09-21-17-${SESSION}.jsonl`),
    ];
    const others = [
      createFile(sessions, "2026", "10", "12", `rollout-2026-10-12T09-22-00-${OTHER}.jsonl`),
      createFile(sessions, "2026", "11", "01", `rollout-2026-11-01T09-22-00-${OTHER}.jsonl`),
      createFile(home, "codex", "session_index.jsonl"),
      createFile(home, "codex", "state_5.sqlite"),
    ];
    // A stray file where a folder is expected must not fail the walk.
    createFile(sessions, "2026", "notes.txt");

    await deleteFiles(codex, home, SESSION);

    expect(own.filter(existsSync)).toEqual([]);
    expect(others.filter((file) => !existsSync(file))).toEqual([]);
  });

  it("succeeds for a session with no files, and for a home with no sessions folder", async () => {
    const home = createHome();
    createFile(home, "codex", "sessions", "2026", "10", "12", `rollout-x-${OTHER}.jsonl`);
    await deleteFiles(codex, home, SESSION);
    await deleteFiles(codex, createHome(), SESSION);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails with the reason when the rollout cannot be deleted",
    async () => {
      const home = createHome();
      const day = join(home, "codex", "sessions", "2026", "10", "12");
      createFile(day, `rollout-2026-10-12T09-21-17-${SESSION}.jsonl`);
      chmodSync(day, 0o500);

      const error = await Effect.runPromise(Effect.flip(codex.deleteSessionFiles(home, SESSION)));

      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toMatch(/permission denied/i);
    },
  );
});

describe("pi deleteSessionFiles", () => {
  it("deletes the session's transcript and leaves another session's", async () => {
    const home = createHome();
    const own = createFile(home, "sessions", `2026-10-08T13-30-36-135Z_${SESSION}.jsonl`);
    const other = createFile(home, "sessions", `2026-10-08T13-31-00-000Z_${OTHER}.jsonl`);
    const settings = createFile(home, "models.json");

    await deleteFiles(pi, home, SESSION);

    expect(existsSync(own)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(settings)).toBe(true);
  });

  it("succeeds for a session with no files, and for a home with no sessions folder", async () => {
    const home = createHome();
    createFile(home, "sessions", `2026-10-08T13-31-00-000Z_${OTHER}.jsonl`);
    await deleteFiles(pi, home, SESSION);
    await deleteFiles(pi, createHome(), SESSION);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails with the reason when the transcript cannot be deleted",
    async () => {
      const home = createHome();
      createFile(home, "sessions", `2026-10-08T13-30-36-135Z_${SESSION}.jsonl`);
      chmodSync(join(home, "sessions"), 0o500);

      const error = await Effect.runPromise(Effect.flip(pi.deleteSessionFiles(home, SESSION)));

      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toMatch(/permission denied/i);
    },
  );
});
