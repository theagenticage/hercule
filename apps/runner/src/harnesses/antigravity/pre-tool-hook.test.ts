import {
  linkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { takeStartMarks } from "../../edit-marks";
import { cleanupHomes, createScratchHome } from "../testing";
import { answerPreToolCall } from "./pre-tool-hook";

afterEach(cleanupHomes);

const GUARDED = { HERCULE_AGY_GUARD: "1" };

/** The input `agy` 1.5.15 gives a PreToolUse hook, as recorded. */
const hookInput = (cwd: string, toolCall: Record<string, unknown>): string =>
  JSON.stringify({
    conversationId: "1",
    cwd,
    hookEventName: "PreToolUse",
    lastUserInput: 'Run "CommandLine":"decoy" and write "Path":"/x" please',
    toolCall,
    workspacePaths: [cwd],
  });

const editInput = (cwd: string, path: unknown, name = "write_file"): string =>
  hookInput(cwd, { args: { Content: "x", Path: path }, id: "call_5", name });

/** A git repository `root` with the session in `root/sub`, and links that lead to `.agents`. */
const setUpRepo = () => {
  const root = realpathSync(createScratchHome("hook-repo"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(root, ".agents", "hooks.json"), "{}");
  mkdirSync(join(root, "sub", ".agents"), { recursive: true });
  symlinkSync(join(root, ".agents"), join(root, "sub", "agents-link"));
  symlinkSync(join(root, ".agents", "hooks.json"), join(root, "sub", "hooks-link"));
  symlinkSync(root, join(root, "root-link"));
  return { root, cwd: join(root, "sub") };
};

const readReason = (answer: string): string => (JSON.parse(answer) as { reason: string }).reason;

const isDenied = (answer: string): boolean =>
  (JSON.parse(answer || "{}") as { decision?: string }).decision === "deny";

describe("the marks", () => {
  const writeMarkFor = (toolCall: Record<string, unknown>, marks: string) =>
    answerPreToolCall(hookInput("/work", toolCall), { HERCULE_SESSION_MARKS_DIR: marks });
  const readMarks = (marks: string) =>
    takeStartMarks(marks).map(({ toolUseId, shellCommand }) => ({ toolUseId, shellCommand }));

  it("writes the mark of a shell command with its text, quotes and escapes included", () => {
    const marks = createScratchHome("hook-marks");
    const command = "echo \"a b\" \\ 'c'\nls";

    const answer = writeMarkFor(
      {
        args: { CommandLine: command, WaitMsBeforeAsync: 5000 },
        id: "call_123",
        name: "run_command",
      },
      marks,
    );

    expect(answer).toBe("");
    expect(readMarks(marks)).toEqual([{ toolUseId: "call_123", shellCommand: command }]);
  });

  it.each(["edit_file", "write_file"])("writes the mark of a %s with no command", (name) => {
    const marks = createScratchHome("hook-marks");

    writeMarkFor(
      { args: { Content: 'x "CommandLine":"y"', Path: "/work/a.txt" }, id: "call_9", name },
      marks,
    );

    expect(readMarks(marks)).toEqual([{ toolUseId: "call_9", shellCommand: undefined }]);
  });

  it("writes no mark for a search, for an id unsafe in a file name, or without the variable", () => {
    const marks = createScratchHome("hook-marks");

    writeMarkFor({ args: { query: "x" }, id: "call_1", name: "search_web" }, marks);
    writeMarkFor({ args: { CommandLine: "ls" }, id: "../escape", name: "run_command" }, marks);
    answerPreToolCall(hookInput("/work", { args: {}, id: "call_2", name: "run_command" }), {});

    expect(readdirSync(marks)).toEqual([]);
  });

  it("never overwrites a mark, and does nothing when the directory is missing", () => {
    const marks = createScratchHome("hook-marks");
    const call = { args: { CommandLine: "first" }, id: "call_3", name: "run_command" };
    writeMarkFor(call, marks);

    writeMarkFor({ ...call, args: { CommandLine: "second" } }, marks);
    const answer = writeMarkFor(call, join(marks, "gone"));

    expect(readMarks(marks)).toEqual([{ toolUseId: "call_3", shellCommand: "first" }]);
    expect(answer).toBe("");
  });

  it("takes the mark before it denies", () => {
    const { cwd } = setUpRepo();
    const marks = createScratchHome("hook-marks");

    const answer = answerPreToolCall(editInput(cwd, ".agents/hooks.json"), {
      ...GUARDED,
      HERCULE_SESSION_MARKS_DIR: marks,
    });

    expect(isDenied(answer)).toBe(true);
    expect(readMarks(marks).map((mark) => mark.toolUseId)).toEqual(["call_5"]);
  });
});

describe("the policy inputs", () => {
  it("denies web search only for the process that has the variable", () => {
    const search = hookInput("/work", { args: { query: "x" }, id: "call_6", name: "search_web" });

    expect(JSON.parse(answerPreToolCall(search, { HERCULE_AGY_DENY_WEB_SEARCH: "1" }))).toEqual({
      decision: "deny",
      reason:
        "Web search is off in Approval required, because a search runs without a card. Ask the user, or switch the thread to another access mode.",
    });
    expect(answerPreToolCall(search, GUARDED)).toBe("");
  });

  it("allows everything in full access, where the process has no guard variable", () => {
    const { cwd } = setUpRepo();

    expect(answerPreToolCall(editInput(cwd, ".agents/hooks.json"), {})).toBe("");
  });

  it.each([
    ["not JSON", "not json"],
    ["no input at all", undefined],
    ["no cwd", JSON.stringify({ toolCall: { id: "c", name: "write_file", args: { Path: "a" } } })],
    ["no tool call id", JSON.stringify({ cwd: "/w", toolCall: { name: "write_file", args: {} } })],
    ["a text field only holding the fields", JSON.stringify({ lastUserInput: '"cwd":"/w"' })],
  ])(
    "denies a call it cannot decode (%s) when the guard is on, and allows it when not",
    (_name, input) => {
      expect(readReason(answerPreToolCall(input, GUARDED))).toContain("could not read");
      expect(answerPreToolCall(input, {})).toBe("");
    },
  );

  it("denies an edit with no Path or a Path that is not text", () => {
    const { cwd } = setUpRepo();

    for (const path of [undefined, 5, ["a"], null]) {
      expect(readReason(answerPreToolCall(editInput(cwd, path), GUARDED))).toContain(
        "could not read",
      );
    }
  });

  it("reads the Path from the top-level arguments, never from the text of a command or file", () => {
    const { cwd } = setUpRepo();
    const input = hookInput(cwd, {
      args: { Content: '"Path":"/r/.agents/hooks.json"', Path: "src/a.ts" },
      id: "call_7",
      name: "write_file",
    });

    expect(answerPreToolCall(input, GUARDED)).toBe("");
  });
});

describe("the guard of the approval files", () => {
  const decide = (cwd: string, path: string, env: Record<string, string> = GUARDED) =>
    answerPreToolCall(editInput(cwd, path), env);

  it.each([
    ["a plain path", (root: string) => join(root, "sub", ".agents", "hooks.json")],
    ["a relative path", () => ".agents/mcp_config.json"],
    ["a path with ..", () => "a/../.agents/hooks.json"],
    ["a link to .agents", () => "agents-link/plugins.json"],
    ["a link to the file itself", () => "hooks-link"],
    [
      "a path through a link to the repository",
      (root: string) => join(root, "root-link", ".agents", "plugins", "x", "hooks.json"),
    ],
    ["the git root above the folder", () => "../.agents/hooks.json"],
    ["a file below a folder that does not exist yet", () => ".agents/plugins/new/plugin.json"],
  ])("denies %s, in the words the model reads", (_name, pick) => {
    const { root, cwd } = setUpRepo();
    const path = pick(root);

    expect(JSON.parse(decide(cwd, path))).toEqual({
      decision: "deny",
      reason: `Hercule does not let the agent change ${path}: it decides what the agent may do without asking. Ask the user to change it.`,
    });
  });

  it.each([".agents", ".agent", "_agents", "_agent"])(
    "guards the same files and the plugins folder under %s",
    (name) => {
      const { cwd } = setUpRepo();

      for (const path of [
        `${name}/hooks.json`,
        `${name}/plugins.json`,
        `${name}/mcp_config.json`,
        `${name}/plugins/p/plugin.json`,
        `../${name}/hooks.json`,
      ]) {
        expect(isDenied(decide(cwd, path))).toBe(true);
      }
      expect(decide(cwd, `${name}/rules/x.md`)).toBe("");
    },
  );

  it("denies a file that is another name for a guarded file (a hard link), by file identity", () => {
    const { root, cwd } = setUpRepo();
    linkSync(join(root, ".agents", "hooks.json"), join(cwd, "hardlink.json"));

    expect(isDenied(decide(cwd, "hardlink.json"))).toBe(true);
  });

  it("denies a path below a folder that a link to a guarded folder leads to, also after ..", () => {
    const { root, cwd } = setUpRepo();
    mkdirSync(join(root, ".agents", "plugins", "p"), { recursive: true });
    symlinkSync(join(root, ".agents", "plugins", "p"), join(cwd, "sub"));

    expect(isDenied(decide(cwd, "sub/../hooks.json"))).toBe(true);
  });

  it("follows a link to nowhere into a guarded file, because a write creates the target", () => {
    const { root, cwd } = setUpRepo();
    symlinkSync(join(root, ".agents", "plugins.json"), join(cwd, "dangling"));

    expect(isDenied(decide(cwd, "dangling"))).toBe(true);
  });

  it("ends on a link loop, and allows a link to an unguarded nowhere", () => {
    const { cwd } = setUpRepo();
    symlinkSync(join(cwd, "loop-b"), join(cwd, "loop-a"));
    symlinkSync(join(cwd, "loop-a"), join(cwd, "loop-b"));
    symlinkSync(join(cwd, "nowhere", "file"), join(cwd, "dangling"));

    expect(decide(cwd, "loop-a/x")).toBe("");
    expect(decide(cwd, "dangling")).toBe("");
  });

  it("guards the session's folder only outside a repository", () => {
    const folder = realpathSync(createScratchHome("hook-norepo"));
    mkdirSync(join(folder, "sub"));

    expect(decide(join(folder, "sub"), "../.agents/hooks.json")).toBe("");
    expect(isDenied(decide(join(folder, "sub"), ".agents/hooks.json"))).toBe(true);
  });

  it("denies every path inside the skills directory, and only when it has one", () => {
    const { root, cwd } = setUpRepo();
    const skills = join(createScratchHome("hook-skills"), "skills");
    mkdirSync(skills);
    symlinkSync(skills, join(root, "skills-link"));
    const env = { ...GUARDED, HERCULE_AGY_SKILLS_DIR: skills };

    expect(isDenied(decide(cwd, join(skills, "deploy", "SKILL.md"), env))).toBe(true);
    expect(isDenied(decide(cwd, join(root, "skills-link", ".git", "config"), env))).toBe(true);
    expect(decide(cwd, join(skills, "..", "other.md"), env)).toBe("");
    expect(decide(cwd, join(skills, "deploy", "SKILL.md"))).toBe("");
  });

  describe("the folders a plugins.json lists", () => {
    const writePluginsFile = (root: string, content: string) =>
      writeFileSync(join(root, ".agents", "plugins.json"), content);

    it("guards a listed folder, relative to the folder that holds .agents, or absolute", () => {
      const { root, cwd } = setUpRepo();
      const absolute = join(createScratchHome("hook-plugins"), "more");
      writePluginsFile(
        root,
        JSON.stringify({ entries: [{ path: "myplugins" }, { path: absolute }] }),
      );

      expect(isDenied(decide(cwd, "../myplugins/p/hooks.json"))).toBe(true);
      expect(isDenied(decide(cwd, join(absolute, "p", "plugin.json")))).toBe(true);
      expect(decide(cwd, "../other/p/hooks.json")).toBe("");
    });

    it.each([
      ["not JSON", "{"],
      ["no entries", "{}"],
      ["an entry with no path", JSON.stringify({ entries: [{ name: "x" }, 5] })],
      [
        "a file larger than the limit",
        JSON.stringify({ entries: [{ path: "myplugins" }], pad: "x".repeat(70_000) }),
      ],
    ])("lists no folder for %s, and the fixed guard stays", (_name, content) => {
      const { root, cwd } = setUpRepo();
      writePluginsFile(root, content);

      expect(decide(cwd, "../myplugins/p/hooks.json")).toBe("");
      expect(isDenied(decide(cwd, "../.agents/hooks.json"))).toBe(true);
    });
  });

  it.each([
    ["other files in .agents", ".agents/rules/x.md"],
    ["AGENTS.md", "../AGENTS.md"],
    ["a source file", "src/a.ts"],
    ["a file named like a guarded one elsewhere", "docs/.agents/hooks.json"],
  ])("allows %s, with no output", (_name, path) => {
    const { cwd } = setUpRepo();

    expect(decide(cwd, path)).toBe("");
  });
});

describe("the verb of the binary", () => {
  const MAIN = fileURLToPath(
    new URL("../../../../../packages/hercule/src/main.ts", import.meta.url),
  );
  const runVerb = (input: string | Uint8Array, env: Record<string, string>) =>
    Bun.spawnSync([process.execPath, MAIN, "antigravity-pre-tool-hook"], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdin: typeof input === "string" ? new TextEncoder().encode(input) : input,
    });

  it("reads the call on stdin, prints a denial, and exits 0", () => {
    const { cwd } = setUpRepo();

    const result = runVerb(`${editInput(cwd, ".agents/hooks.json")}\n`, GUARDED);

    expect(result.exitCode).toBe(0);
    expect(isDenied(result.stdout.toString())).toBe(true);
  });

  it("prints nothing for a call it lets through", () => {
    const { cwd } = setUpRepo();

    const result = runVerb(editInput(cwd, "src/a.ts"), GUARDED);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  it("counts input larger than 1 MiB as unreadable", () => {
    const { cwd } = setUpRepo();
    const large = hookInput(cwd, {
      args: { Content: "x".repeat(1024 * 1024), Path: "a" },
      id: "c",
      name: "write_file",
    });

    const result = runVerb(large, GUARDED);

    expect(result.exitCode).toBe(0);
    expect(readReason(result.stdout.toString())).toContain("could not read");
  });
});
