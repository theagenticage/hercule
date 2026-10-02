import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { describeFolder, pickFolder } from "./folder-pick";
import { runProgram } from "./run-program";
import { makeFakeMainWindow } from "./testing";

let folder: string;
let home: string;

beforeEach(() => {
  // The temporary folder is in no repository, so a folder in it is not in
  // one until a test makes it one.
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-folder-pick-"));
  // git reads the user's own config from HOME and XDG_CONFIG_HOME, so each
  // test gets an empty home: the developer's config cannot change what git
  // prints, and a test can write a config of its own.
  home = mkdtempSync(join(tmpdir(), "hercule-desktop-folder-pick-home-"));
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(folder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
});

/**
 * Runs git with `args` in `cwd`, with no GIT_* variable but
 * `GIT_CONFIG_NOSYSTEM`, so this Mac's system config is not read, and with a
 * fixed author. Throws with git's error when git exits with another code
 * than 0.
 */
const runGit = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
  const exit = await Effect.runPromise(
    runProgram(
      "/usr/bin/git",
      ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args],
      {
        cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
          ),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    ),
  );
  if (exit.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${exit.stderr}`);
};

/** Creates a repository named `name` in the temporary folder, on `main`, and returns its path. */
const createRepository = async (name: string): Promise<string> => {
  const path = join(folder, name);
  mkdirSync(path);
  await runGit(path, ["init", "--quiet", "--initial-branch=main"]);
  return path;
};

/** Runs `describeFolder` on `path` and returns its outcome. */
const runDescribeFolder = (path: string) => Effect.runPromise(describeFolder(path));

describe("describeFolder", () => {
  it("describes a repository with an origin remote, before its first commit", async () => {
    const path = await createRepository("api");
    await runGit(path, ["remote", "add", "origin", "https://example.com/ada/api.git"]);
    expect(await runDescribeFolder(path)).toEqual({
      _tag: "Repository",
      name: "api",
      remote: "https://example.com/ada/api.git",
      branch: "main",
    });
  });

  it("removes the token an insteadOf rule in the user's git config adds to an https remote", async () => {
    writeFileSync(
      join(home, ".gitconfig"),
      '[url "https://x-access-token:ghp_FAKE@example.com/"]\n\tinsteadOf = https://example.com/\n',
    );
    const path = await createRepository("api");
    await runGit(path, ["remote", "add", "origin", "https://example.com/ada/api.git"]);
    expect(await runDescribeFolder(path)).toEqual({
      _tag: "Repository",
      name: "api",
      remote: "https://example.com/ada/api.git",
      branch: "main",
    });
  });

  it("removes the user name and password an https remote was added with", async () => {
    const path = await createRepository("api");
    await runGit(path, ["remote", "add", "origin", "https://ada:secret@example.com/ada/api.git"]);
    expect(await runDescribeFolder(path)).toMatchObject({
      remote: "https://example.com/ada/api.git",
    });
  });

  it("returns an scp-like ssh remote unchanged", async () => {
    const path = await createRepository("api");
    await runGit(path, ["remote", "add", "origin", "git@example.com:ada/api.git"]);
    expect(await runDescribeFolder(path)).toMatchObject({ remote: "git@example.com:ada/api.git" });
  });

  it("describes a repository with no origin remote", async () => {
    const path = await createRepository("notes");
    await runGit(path, ["remote", "add", "upstream", "https://example.com/notes.git"]);
    expect(await runDescribeFolder(path)).toEqual({
      _tag: "NoRemote",
      name: "notes",
      branch: "main",
    });
  });

  it("describes a folder inside a repository by the folder's own name", async () => {
    const path = await createRepository("mono");
    mkdirSync(join(path, "web"));
    expect(await runDescribeFolder(join(path, "web"))).toEqual({
      _tag: "NoRemote",
      name: "web",
      branch: "main",
    });
  });

  it("returns a null branch when HEAD is detached", async () => {
    const path = await createRepository("detached");
    await runGit(path, ["commit", "--quiet", "--allow-empty", "-m", "first"]);
    await runGit(path, ["checkout", "--quiet", "--detach"]);
    expect(await runDescribeFolder(path)).toEqual({
      _tag: "NoRemote",
      name: "detached",
      branch: null,
    });
  });

  it("describes a folder in no repository", async () => {
    const path = join(folder, "plain");
    mkdirSync(path);
    expect(await runDescribeFolder(path)).toEqual({ _tag: "NotGit", name: "plain" });
  });

  it("returns git's error for a folder git cannot read", async () => {
    const outcome = await runDescribeFolder(join(folder, "missing"));
    expect(outcome).toMatchObject({ _tag: "GitFailed", name: "missing" });
    expect(outcome._tag === "GitFailed" && outcome.line).toMatch(/^fatal: cannot change to /);
  });
});

describe("pickFolder", () => {
  /** Picks a folder in the fake window, which returns `picked`. */
  const pick = async (picked: string | null) => {
    const window = makeFakeMainWindow();
    window.pickedFolder = picked;
    const outcome = await Effect.runPromise(Effect.provide(pickFolder, window.layer));
    return { outcome, calls: window.calls };
  };

  it("returns Cancelled when the user cancels the dialog", async () => {
    expect(await pick(null)).toEqual({ outcome: { _tag: "Cancelled" }, calls: ["pickFolder"] });
  });

  it("describes the folder the user picked", async () => {
    const path = join(folder, "plain");
    mkdirSync(path);
    expect(await pick(path)).toEqual({
      outcome: { _tag: "NotGit", name: "plain" },
      calls: ["pickFolder"],
    });
  });
});
