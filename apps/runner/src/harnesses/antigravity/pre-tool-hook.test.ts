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
import { SESSION_MARKS_DIR_VARIABLE } from "../../edit-marks/mark-format";
import { cleanupHomes, createScratchHome } from "../testing";
import { HOOK_RULES_VARIABLE, answerPreToolCall, encodeHookRules } from "./pre-tool-hook";
import type { HookRules } from "./pre-tool-hook";

afterEach(cleanupHomes);

/** The environment of an `agy` process whose session has these rules. */
const rulesEnv = (
  accessMode: HookRules["accessMode"],
  rules: Partial<Omit<HookRules, "accessMode">> = {},
): Record<string, string> => ({
  [HOOK_RULES_VARIABLE]: encodeHookRules({
    accessMode,
    readOnlyFolders: [],
    harnessHomePaths: [],
    conversationIdFile: "/nowhere/conversation-id",
    ...rules,
  }),
});

/** Every mode but Full access guards the files; only Approval required also denies web search. */
const GUARDED = rulesEnv("auto-accept-edits");
const APPROVAL = rulesEnv("approval-required");
const FULL = rulesEnv("full-access");
const CONFIG_FOLDERS = [".agents", ".agent", "_agents", "_agent"];

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
  it("denies web search only in Approval required", () => {
    const search = hookInput("/work", { args: { query: "x" }, id: "call_6", name: "search_web" });

    expect(JSON.parse(answerPreToolCall(search, APPROVAL))).toEqual({
      decision: "deny",
      reason:
        "Web search is off in Approval required, because a search runs without a card. Ask the user, or switch the thread to another access mode.",
    });
    expect(answerPreToolCall(search, GUARDED)).toBe("");
    expect(answerPreToolCall(search, FULL)).toBe("");
  });

  describe("the browser agent", () => {
    const subagent = (typeName: unknown) =>
      hookInput("/work", {
        args: { Prompt: "x", Role: "Web Browser", TypeName: typeName },
        id: "call_8",
        name: "invoke_subagent",
      });
    const chromeCall = hookInput("/work", {
      args: { toolSummary: "List open pages" },
      id: "call_9",
      name: "mcp_chrome_devtools_list_pages",
    });

    it.each([
      ["Approval required", APPROVAL],
      ["Auto-accept edits", GUARDED],
    ])("denies both ways in to it in %s, with a reason that says what to do", (mode, env) => {
      for (const input of [subagent("browser"), chromeCall]) {
        const reason = readReason(answerPreToolCall(input, env));
        expect(reason).toBe(
          `The browser agent is off in ${mode}: it acts in your own Chrome, with your logins, and Hercule cannot ask you first. Switch the thread to Full access to use it.`,
        );
      }
    });

    it("allows both in Full access", () => {
      expect(answerPreToolCall(subagent("browser"), FULL)).toBe("");
      expect(answerPreToolCall(chromeCall, FULL)).toBe("");
    });

    it.each([" Browser ", "BROWSER", "browser\n", "\u0085browser\u00A0"])(
      "denies TypeName %j",
      (typeName) => {
        expect(isDenied(answerPreToolCall(subagent(typeName), GUARDED))).toBe(true);
      },
    );

    it("allows every other subagent, and writes no mark for it", () => {
      const marks = createScratchHome("marks");
      const env = { ...APPROVAL, [SESSION_MARKS_DIR_VARIABLE]: marks };

      for (const typeName of ["general", "", undefined, 5, "browser agent"]) {
        expect(answerPreToolCall(subagent(typeName), env)).toBe("");
      }
      expect(readdirSync(marks)).toEqual([]);
    });

    it("denies a subagent call it cannot decode, with the reason for an unreadable call", () => {
      const undecodable = JSON.stringify({
        cwd: "/work",
        toolCall: { id: "c", name: "invoke_subagent", args: "TypeName=browser" },
      });

      expect(readReason(answerPreToolCall(undecodable, GUARDED))).toContain("could not read");
      expect(answerPreToolCall(undecodable, FULL)).toBe("");
    });
  });

  it("allows everything in Full access, and only there", () => {
    const { cwd } = setUpRepo();

    expect(answerPreToolCall(editInput(cwd, ".agents/hooks.json"), FULL)).toBe("");
    expect(answerPreToolCall("not json", FULL)).toBe("");
  });

  it.each([
    ["missing", {}],
    ["empty", { [HOOK_RULES_VARIABLE]: "" }],
    ["not JSON", { [HOOK_RULES_VARIABLE]: "{" }],
    [
      "an unknown mode",
      { [HOOK_RULES_VARIABLE]: '{"accessMode":"yolo","readOnlyFolders":[],"harnessHomePaths":[]}' },
    ],
    [
      "an old mode that is not exact",
      {
        [HOOK_RULES_VARIABLE]:
          '{"accessMode":"Full access","readOnlyFolders":[],"harnessHomePaths":[]}',
      },
    ],
    ["without the folders", { [HOOK_RULES_VARIABLE]: '{"accessMode":"full-access"}' }],
    [
      "folders that are not text",
      {
        [HOOK_RULES_VARIABLE]:
          '{"accessMode":"full-access","readOnlyFolders":[1],"harnessHomePaths":[]}',
      },
    ],
  ])(
    "denies edits, searches and calls it cannot read, with its own reason, when the rules are %s",
    (_name, env) => {
      const { cwd } = setUpRepo();
      const search = hookInput(cwd, { args: { query: "x" }, id: "call_6", name: "search_web" });

      for (const answer of [
        answerPreToolCall(editInput(cwd, "src/a.ts"), env),
        answerPreToolCall(search, env),
        answerPreToolCall(
          hookInput(cwd, { args: { TypeName: "browser" }, id: "c", name: "invoke_subagent" }),
          env,
        ),
        answerPreToolCall("not json", env),
      ]) {
        expect(readReason(answer)).toContain("own setup for this session is wrong");
        expect(readReason(answer)).toContain("Full access");
      }
      expect(
        answerPreToolCall(
          hookInput(cwd, { args: { CommandLine: "ls" }, id: "c", name: "run_command" }),
          env,
        ),
      ).toBe("");
    },
  );

  it.each([
    ["not JSON", "not json"],
    ["no input at all", undefined],
    ["no cwd", JSON.stringify({ toolCall: { id: "c", name: "write_file", args: { Path: "a" } } })],
    ["no tool call id", JSON.stringify({ cwd: "/w", toolCall: { name: "write_file", args: {} } })],
    ["a text field only holding the fields", JSON.stringify({ lastUserInput: '"cwd":"/w"' })],
  ])(
    "denies a call it cannot decode (%s) outside Full access, and allows it there",
    (_name, input) => {
      expect(readReason(answerPreToolCall(input, GUARDED))).toContain("could not read");
      expect(readReason(answerPreToolCall(input, APPROVAL))).toContain("could not read");
      expect(answerPreToolCall(input, FULL)).toBe("");
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

describe("a subagent's call", () => {
  const OWN = "11111111-1111-1111-1111-111111111111";
  const CHILD = "22222222-2222-2222-2222-222222222222";
  const callIn = (conversationId: unknown, toolCall: Record<string, unknown>): string =>
    JSON.stringify({ conversationId, cwd: "/work", toolCall });
  const command = (conversationId: unknown) =>
    callIn(conversationId, { args: { CommandLine: "ls" }, id: "call_1", name: "run_command" });
  const edit = (conversationId: unknown) =>
    callIn(conversationId, {
      args: { Content: "x", Path: "/work/a.txt" },
      id: "call_2",
      name: "write_file",
    });
  const read = (conversationId: unknown) =>
    callIn(conversationId, {
      args: { AbsolutePath: "/work/a.txt" },
      id: "call_3",
      name: "view_file",
    });

  /** The environment of a session whose own conversation id is `ownId`, or whose file is missing for undefined. */
  const sessionEnv = (mode: HookRules["accessMode"], ownId: string | undefined) => {
    const file = join(createScratchHome("hook-conversation"), "conversation-id");
    if (ownId !== undefined) writeFileSync(file, ownId);
    return rulesEnv(mode, { conversationIdFile: file });
  };

  it.each([
    ["Approval required", "approval-required", "command", command],
    ["Approval required", "approval-required", "file change", edit],
    ["Auto-accept edits", "auto-accept-edits", "command", command],
    ["Auto-accept edits", "auto-accept-edits", "file change", edit],
  ] as const)(
    "is denied in %s for a %s, with a reason that says what to do",
    (name, mode, what, build) => {
      const reason = readReason(answerPreToolCall(build(CHILD), sessionEnv(mode, OWN)));

      expect(reason).toBe(
        `Hercule refused this subagent's ${what}: in ${name} a subagent cannot ask you for approval, because Antigravity does not pass its requests on. Do this step in the main agent, or switch the thread to Full access.`,
      );
    },
  );

  it.each(["approval-required", "auto-accept-edits"] as const)(
    "lets the session's own command and file change run in %s",
    (mode) => {
      const env = sessionEnv(mode, OWN);

      expect(answerPreToolCall(command(OWN), env)).toBe("");
      expect(answerPreToolCall(edit(OWN), env)).toBe("");
    },
  );

  it("lets a subagent's read run", () => {
    expect(answerPreToolCall(read(CHILD), sessionEnv("approval-required", OWN))).toBe("");
  });

  it("denies nothing in Full access", () => {
    const env = sessionEnv("full-access", OWN);

    expect(answerPreToolCall(command(CHILD), env)).toBe("");
    expect(answerPreToolCall(edit(CHILD), env)).toBe("");
  });

  it.each([
    ["the file is missing", undefined],
    ["the file is empty", ""],
    ["the file holds more than an id", "not an id\n../x"],
  ])("does not apply when %s", (_name, own) => {
    const env = sessionEnv("approval-required", own);

    expect(answerPreToolCall(command(CHILD), env)).toBe("");
    expect(answerPreToolCall(edit(CHILD), env)).toBe("");
  });

  it("does not apply when the path cannot be read as a file", () => {
    const folder = createScratchHome("hook-conversation");
    const env = rulesEnv("approval-required", { conversationIdFile: folder });

    expect(answerPreToolCall(command(CHILD), env)).toBe("");
  });

  it("does not apply to a call with no conversation id", () => {
    const env = sessionEnv("approval-required", OWN);

    expect(answerPreToolCall(command(undefined), env)).toBe("");
    expect(answerPreToolCall(command(5), env)).toBe("");
  });

  it("gives a guarded path its own reason first", () => {
    const { cwd } = setUpRepo();
    const input = JSON.stringify({
      conversationId: CHILD,
      cwd,
      toolCall: {
        args: { Content: "x", Path: ".agents/hooks.json" },
        id: "call_4",
        name: "write_file",
      },
    });

    expect(readReason(answerPreToolCall(input, sessionEnv("approval-required", OWN)))).toContain(
      "decides what the agent may do without asking",
    );
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

  it.each(CONFIG_FOLDERS)("guards the same files and the plugins folder under %s", (name) => {
    const { cwd } = setUpRepo();

    for (const path of [
      `${name}/hooks.json`,
      `${name}/plugins.json`,
      `${name}/mcp_config.json`,
      `${name}/agents.json`,
      `${name}/rules.json`,
      `${name}/plugins/p/plugin.json`,
      `../${name}/hooks.json`,
    ]) {
      expect(isDenied(decide(cwd, path))).toBe(true);
    }
    expect(decide(cwd, `${name}/rules/x.md`)).toBe("");
  });

  it.each([
    [".agents/hooks.json "],
    [".agents/hooks.json\n"],
    [".agents/hooks.json\u0085"],
    [".agents/hooks.json\u00A0"],
    [".agents/hooks.json\u3000"],
    ["\t .agents/hooks.json \r\n"],
  ])("denies %j, a guarded path with whitespace around it, which agy may trim", (path) => {
    const { cwd } = setUpRepo();

    expect(isDenied(decide(cwd, path))).toBe(true);
    expect(decide(cwd, "src/a.ts ")).toBe("");
  });

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

  it("denies every path inside each read-only folder, and only when the rules list them", () => {
    const { root, cwd } = setUpRepo();
    const skills = join(createScratchHome("hook-skills"), "skills");
    const other = join(createScratchHome("hook-other"), "docs");
    mkdirSync(skills);
    mkdirSync(other);
    symlinkSync(skills, join(root, "skills-link"));
    const env = rulesEnv("auto-accept-edits", { readOnlyFolders: [skills, other] });

    expect(readReason(decide(cwd, join(other, "a.md"), env))).toBe(
      `Hercule gives the agent this folder to read, not to change: ${join(other, "a.md")}. Ask the user to change it.`,
    );
    expect(isDenied(decide(cwd, join(skills, "deploy", "SKILL.md"), env))).toBe(true);
    expect(isDenied(decide(cwd, join(root, "skills-link", ".git", "config"), env))).toBe(true);
    expect(decide(cwd, join(skills, "..", "other.md"), env)).toBe("");
    expect(decide(cwd, join(skills, "deploy", "SKILL.md"))).toBe("");
  });

  it("denies every path the Harness Home owns, with the reason of Hercule's own files", () => {
    const { cwd } = setUpRepo();
    const home = createScratchHome("hook-home");
    const hooks = join(home, "config", "hooks.json");
    const env = rulesEnv("approval-required", {
      harnessHomePaths: [hooks, join(home, "config", "plugins")],
    });

    expect(readReason(decide(cwd, hooks, env))).toBe(
      `Hercule does not let the agent change ${hooks}: it decides what the agent may do without asking. Ask the user to change it.`,
    );
    expect(isDenied(decide(cwd, join(home, "config", "plugins", "p", "x.json"), env))).toBe(true);
    expect(decide(cwd, join(home, "config", "other.json"), env)).toBe("");
    expect(decide(cwd, hooks, FULL)).toBe("");
  });

  it.each([
    [".agents/Hooks.json"],
    [".agents/MCP_CONFIG.json"],
    [".agents/Plugins/p/hooks.json"],
    [".AGENTS/hooks.json"],
    ["_Agents/mcp_config.json"],
    [".agents/plugins.JSON"],
    [".agents/hoo\u212As.json"],
    [".agents/hook\u017F.json"],
    [".agents/plugins.j\u017Fon"],
    [".agents/mcp_conf\u0131g.json"],
  ])("denies %s, a file that does not exist, spelled in another case", (path) => {
    const folder = realpathSync(createScratchHome("hook-case"));

    expect(isDenied(decide(folder, path))).toBe(true);
  });

  const HFS_IGNORED = [
    ...[0x200c, 0x200d, 0x200e, 0x200f],
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
    ...[0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f],
    0xfeff,
  ];

  it.each(HFS_IGNORED.map((code) => [`U+${code.toString(16).toUpperCase()}`, code] as const))(
    "denies a guarded name with %s inside it, which an HFS+ volume ignores",
    (_label, code) => {
      const folder = realpathSync(createScratchHome("hook-hfs"));
      const ignored = String.fromCodePoint(code);

      expect(isDenied(decide(folder, `.agents/hooks${ignored}.json`))).toBe(true);
      expect(isDenied(decide(folder, `.agents${ignored}/plugins/p.json`))).toBe(true);
      expect(decide(folder, ".agents/notes.json")).toBe("");
    },
  );

  it("denies another Unicode normalization form and other case folding of a read-only folder", () => {
    const folder = realpathSync(createScratchHome("hook-unicode"));
    const readOnly = join(folder, "r\u00E9sum\u00E9s");
    const env = rulesEnv("auto-accept-edits", { readOnlyFolders: [readOnly] });

    expect(isDenied(decide(folder, `re\u0301sume\u0301s/new.md`, env))).toBe(true);
    expect(isDenied(decide(folder, `R\u00C9SUM\u00C9S/new.md`, env))).toBe(true);
    expect(decide(folder, "resumes/new.md", env)).toBe("");
  });

  it("reads a Path that starts with ~ or is a file: URL as the path it may name, and guards both", () => {
    const { root, cwd } = setUpRepo();
    const hooks = join(root, ".agents", "hooks.json");
    const home = root;
    const env = { ...GUARDED, HOME: home };

    expect(isDenied(answerPreToolCall(editInput(cwd, "~/.agents/hooks.json"), env))).toBe(true);
    expect(isDenied(decide(cwd, `file://${hooks}`))).toBe(true);
    expect(isDenied(decide(cwd, `FILE://${hooks}`))).toBe(true);
    expect(isDenied(decide(cwd, `File:${hooks}`))).toBe(true);
    expect(isDenied(decide(cwd, `file:${hooks}`))).toBe(true);
    expect(decide(cwd, `FILE://${join(root, "src", "a.ts")}`)).toBe("");
    expect(decide(cwd, "~/src/a.ts")).toBe("");
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

    it("guards the folder an entry `.` names, saying that the manifest lists it", () => {
      const { root, cwd } = setUpRepo();
      writePluginsFile(root, JSON.stringify({ entries: [{ path: "." }] }));

      const reason = readReason(decide(cwd, "src/a.ts"));

      expect(reason).toContain(`${join(root, ".agents", "plugins.json")} lists a plugin folder`);
      expect(reason).not.toContain("it decides what the agent may do without asking");
    });

    it("lists no folder for a manifest with no entries, and the fixed guard stays", () => {
      const { root, cwd } = setUpRepo();
      writePluginsFile(root, "{}");

      expect(decide(cwd, "../myplugins/p/hooks.json")).toBe("");
      expect(isDenied(decide(cwd, "../.agents/hooks.json"))).toBe(true);
    });

    it("treats a missing manifest as no problem", () => {
      const { cwd } = setUpRepo();

      expect(decide(cwd, "../myplugins/p/hooks.json")).toBe("");
    });

    it.each([
      ["not JSON", "{"],
      ["JSON of another shape", "5"],
      ["an entry with no path", JSON.stringify({ entries: [{ name: "x" }] })],
      ["an entry that is a bare string", JSON.stringify({ entries: ["myplugins"] })],
      ["an entry whose path is not text", JSON.stringify({ entries: [{ path: 5 }] })],
      [
        "a file larger than the limit",
        JSON.stringify({ entries: [{ path: "myplugins" }], pad: "x".repeat(70_000) }),
      ],
    ])("denies every edit, naming the manifest, when the manifest is %s", (_name, content) => {
      const { root, cwd } = setUpRepo();
      writePluginsFile(root, content);

      const reason = readReason(decide(cwd, "src/a.ts"));

      expect(reason).toContain(join(root, ".agents", "plugins.json"));
      expect(reason).toContain("Repair or remove the file");
      expect(reason).not.toContain("could not read this tool call");
    });

    it.each(CONFIG_FOLDERS)(
      "denies every edit when the manifest under %s is not a regular file",
      (name) => {
        const { root, cwd } = setUpRepo();
        mkdirSync(join(root, name), { recursive: true });
        mkdirSync(join(root, name, "plugins.json"));

        expect(readReason(decide(cwd, "src/a.ts"))).toContain(join(root, name, "plugins.json"));
      },
    );

    it("does not hang on a named pipe in place of the manifest, and denies", () => {
      const { root, cwd } = setUpRepo();
      mkdirSync(join(root, "_agents"));
      expect(Bun.spawnSync(["mkfifo", join(root, "_agents", "plugins.json")]).exitCode).toBe(0);

      expect(readReason(decide(cwd, "src/a.ts"))).toContain(join(root, "_agents", "plugins.json"));
    });
  });

  it("denies an edit, saying the folder is too deep, when the walk to the git root passes the folder limit", () => {
    const folder = realpathSync(createScratchHome("hook-deep"));
    const deep = join(folder, ...Array.from({ length: 70 }, () => "d"));
    mkdirSync(deep, { recursive: true });

    const reason = readReason(decide(deep, "a.ts"));

    expect(reason).toContain("more than 64 folders");
    expect(reason).toContain("Full access");
    expect(reason).not.toContain("could not read this tool call");
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

describe("an unexpected failure", () => {
  /** An environment that throws when the home folder is read, which the hook does while it checks an edit. */
  const failingEnv = (env: Record<string, string>): Record<string, string | undefined> =>
    new Proxy(env, {
      get: (target, key) => {
        if (key === "HOME") throw new Error("injected failure");
        return target[key as string];
      },
    });
  const input = editInput("/work", "a.ts");

  it.each([
    ["Approval required", APPROVAL],
    ["another mode", GUARDED],
    ["rules that do not decode", {}],
  ])("prints a denial that says the check failed, in %s", (_name, env) => {
    const answer = answerPreToolCall(input, failingEnv(env));

    expect(isDenied(answer)).toBe(true);
    expect(readReason(answer)).toMatch(/check of this tool call failed|own setup/);
  });

  it("still gives the decision when the marks cannot be written", () => {
    const marks = join(createScratchHome("hook-marks"), "file");
    writeFileSync(marks, "not a folder");
    const { cwd } = setUpRepo();
    const env = { ...GUARDED, HERCULE_SESSION_MARKS_DIR: marks };

    expect(isDenied(answerPreToolCall(editInput(cwd, ".agents/hooks.json"), env))).toBe(true);
    expect(answerPreToolCall(editInput(cwd, "src/a.ts"), env)).toBe("");
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

  it("exits 0 with nothing on stdout for input that is not JSON, in Full access", () => {
    const result = runVerb("not json", FULL);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
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
    expect(readReason(result.stdout.toString())).toContain("too large for Hercule to check");
  });

  it.each([
    ["Full access", FULL],
    ["a guarded mode", GUARDED],
  ])(
    "reads a 2 MiB input to its end, so a shell that writes it is not killed by a broken pipe, in %s",
    (_n, env) => {
      // A shell writer reports its status, which shows a SIGPIPE (141) on every
      // platform; a Bun writer reports no error on macOS.
      const result = Bun.spawnSync(
        [
          "sh",
          "-c",
          '{ head -c 2097152 /dev/zero; echo "writer=$?" >&2; } | "$@"',
          "sh",
          process.execPath,
          MAIN,
          "antigravity-pre-tool-hook",
        ],
        { env: { PATH: process.env["PATH"] ?? "", ...env } },
      );

      expect(result.stderr.toString()).toBe("writer=0\n");
      expect(result.exitCode).toBe(0);
      const answer = result.stdout.toString();
      if (env === FULL) expect(answer).toBe("");
      else expect(answer).toContain("too large for Hercule to check");
    },
  );
});
