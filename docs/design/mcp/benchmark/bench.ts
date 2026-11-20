/**
 * Measures an agent operating Hercule through the `hercule` CLI against the
 * same agent operating it through MCP tools.
 *
 * Each run gives a headless Claude Code one task, in one arm:
 *
 * - `cli`: what a session gets today. The `hercule` binary on PATH, the
 *   session orientation in the system prompt, and the Hercule skill as a
 *   Claude plugin.
 * - `mcp-search`: one MCP tool per operation, with Claude Code's tool search
 *   on, so a tool's schema is loaded only when the agent searches for it.
 * - `mcp-eager`: the same tools, all loaded into the context up front.
 * - `mcp-meta`: two MCP tools, `hercule_help` and `hercule_call`.
 *
 * Every run gets a project of its own with the same seeded tasks, and the
 * result is checked against the controller's state afterwards, never against
 * what the agent says it did (one task asks for a number, and its answer is
 * the reply).
 *
 * Usage:
 *   bun docs/design/mcp/benchmark/bench.ts <state file> <results.jsonl> \
 *     [--model sonnet] [--reps 3] [--arms cli,mcp-search] [--tasks count,create] [--parallel 4]
 *
 * The state file is the one `serve.ts` writes. It names a controller in a
 * throwaway Hercule Home; nothing here reads `~/.hercule`.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HERCULE_SKILL,
  SESSION_ORIENTATION,
  SKILL_DESCRIPTION,
} from "../../../../apps/runner/src/sessions/skill";

const [stateFile, resultsFile, ...flags] = process.argv.slice(2);
if (stateFile === undefined || resultsFile === undefined) {
  throw new Error("usage: bench.ts <state file> <results.jsonl> [flags]");
}
const readFlag = (name: string, fallback: string): string => {
  const index = flags.indexOf(`--${name}`);
  return index === -1 ? fallback : flags[index + 1]!;
};

const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
  url: string;
  apiKey: string;
  binary: string;
};
const MODEL = readFlag("model", "sonnet");
const REPS = Number(readFlag("reps", "3"));
const PARALLEL = Number(readFlag("parallel", "4"));
const HERE = import.meta.dirname;

/** `claude` runs headless Claude Code; `codex` runs `codex exec`. */
const HARNESS = readFlag("harness", "claude") as "claude" | "codex";

/**
 * `mcp-ops` is the Codex spelling of "one tool per operation": Codex has no
 * switch between searching for tools and loading them all, so it has one such
 * arm where Claude Code has `mcp-search` and `mcp-eager`.
 */
const ARMS = ["cli", "mcp-search", "mcp-eager", "mcp-ops", "mcp-meta"] as const;
type Arm = (typeof ARMS)[number];
const DEFAULT_ARMS: ReadonlyArray<Arm> =
  HARNESS === "codex" ? ["cli", "mcp-ops", "mcp-meta"] : ["cli", "mcp-search", "mcp-eager", "mcp-meta"];

/** The directory that holds what every run shares: the CLI's bin folder and the skill plugin. */
const shared = mkdtempSync(join(tmpdir(), "hercule-mcp-bench-shared-"));
const binDir = join(shared, "bin");
mkdirSync(binDir);
symlinkSync(state.binary, join(binDir, "hercule"));

/** Writes the Claude plugin that holds the Hercule skill, as the runner's `prepareTooling` does. */
const pluginDir = join(shared, "claude-plugin");
mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
writeFileSync(
  join(pluginDir, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "hercule", description: SKILL_DESCRIPTION, version: "0.1.0" }),
);
mkdirSync(join(pluginDir, "skills", "hercule"), { recursive: true });
writeFileSync(
  join(pluginDir, "skills", "hercule", "SKILL.md"),
  `---\nname: hercule\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${HERCULE_SKILL}`,
);

/** What an MCP arm's session is told in place of the CLI's orientation. Same length, same promises. */
const MCP_ORIENTATION: Record<Exclude<Arm, "cli">, string> = {
  "mcp-search": `This session runs inside Hercule, the platform that started it. Hercule's operations are tools of the **hercule** MCP server, already signed in as this session: one tool per operation, named \`<noun>_<verb>\`, such as \`task_create\`, \`task_list\` and \`session_spawn\`.

Other sessions are reached through Hercule. To start a session, on any harness or model, use \`session_spawn\`. To send a message to a session that exists, use \`session_input\`. If your harness has its own way to reach other sessions or agents outside this one, do not use it: Hercule would not see that work, and nobody could follow it. Your harness's own subagent tool, if it has one, starts a helper inside this session, and that is fine to use.`,
  "mcp-eager": "",
  "mcp-ops": "",
  "mcp-meta": `This session runs inside Hercule, the platform that started it. Hercule's operations are reached through two tools of the **hercule** MCP server, already signed in as this session: \`hercule_help\` lists everything Hercule can do and describes one operation, and \`hercule_call\` runs one.

Other sessions are reached through Hercule. To start a session, on any harness or model, see \`hercule_help\` for \`session spawn\`. To send a message to a session that exists, see \`session input\`. If your harness has its own way to reach other sessions or agents outside this one, do not use it: Hercule would not see that work, and nobody could follow it. Your harness's own subagent tool, if it has one, starts a helper inside this session, and that is fine to use.`,
};
MCP_ORIENTATION["mcp-eager"] = MCP_ORIENTATION["mcp-search"];
MCP_ORIENTATION["mcp-ops"] = MCP_ORIENTATION["mcp-search"];

/** The environment of every process this file starts: nothing of the surrounding Hercule session. */
const baseEnv = (): Record<string, string> => {
  const keep = ["HOME", "USER", "LANG", "TMPDIR", "TERM", "SHELL", "CLAUDE_CONFIG_DIR"];
  const env: Record<string, string> = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  // The surrounding session's PATH starts with its own runner's bin folder,
  // whose `hercule` talks to the user's live controller. Leave it out.
  env["PATH"] = (process.env["PATH"] ?? "")
    .split(":")
    .filter((entry) => !entry.includes("/.hercule/"))
    .join(":");
  return env;
};

const herculeEnv = { HERCULE_API_URL: state.url, HERCULE_TOKEN: state.apiKey };

/** Runs the CLI against the bench controller and returns its `--json` output. */
const cli = <A>(args: ReadonlyArray<string>, stdin?: string): A => {
  const ran = spawnSync(state.binary, [...args, "--json"], {
    env: { ...baseEnv(), ...herculeEnv },
    input: stdin ?? "",
    encoding: "utf8",
  });
  if (ran.status !== 0) throw new Error(`hercule ${args.join(" ")} failed:\n${ran.stderr}${ran.stdout}`);
  return JSON.parse(ran.stdout) as A;
};

interface Task {
  id: string;
  title: string;
  stage: string;
  priority: string;
  labels: Array<string>;
  projectId?: string;
  initiativeId?: string;
  description: string;
}

interface World {
  n: string;
  project: string;
  projectId: string;
  otherProjectId: string;
  tasks: Record<string, Task>;
  resourceId: string;
  remote: string;
  pageId: string;
  initiativeId: string;
  /** The directory the agent runs in, set once the run has one. */
  cwd: string;
  cleanup: Array<() => void>;
}

const WIKI_BODY = `# Release process

1. Tag \`main\` with the version.
2. Run the release workflow and wait for the green check.
3. Announce it in #releases.
`;

/** One seeded task: a key the checks use, and what the task starts as. */
const SEED: ReadonlyArray<readonly [string, string, string, string, ReadonlyArray<string>]> = [
  ["login", "Fix the flaky login test", "planned", "normal", ["triage"]],
  ["checkoutCards", "Checkout fails on expired cards", "building", "high", []],
  ["checkoutSlow", "Slow checkout page on mobile", "in-review", "normal", []],
  ["checkoutGift", "Add gift cards to checkout", "planned", "normal", []],
  ["pricingPage", "Ship the new pricing page", "planned", "high", []],
  ["pricingCopy", "Finalize pricing copy", "building", "normal", []],
  ["legacyCoupons", "Remove the old coupon engine", "planned", "normal", ["legacy"]],
  ["legacyCron", "Migrate cron jobs off the VM", "building", "high", ["legacy", "ops"]],
  ["legacyIe", "Drop the IE11 stylesheet", "done", "normal", ["legacy"]],
  ["legacyDocs", "Archive the v1 API docs", "exploring", "normal", ["legacy"]],
  ["legacyFlags", "Delete unused feature flags", "planned", "urgent", ["legacy"]],
  ["search", "Search results ignore accents", "in-review", "normal", []],
  ["invoices", "Invoices show the wrong VAT rate", "in-review", "urgent", ["finance"]],
  ["newsletter", "Newsletter signup form", "planned", "low", []],
];

let counter = 0;

/** Creates one run's own project, tasks, repository and wiki page. */
const seedWorld = (): World => {
  const n = `${Date.now().toString(36)}${(counter++).toString(36)}`;
  const project = `Webshop ${n}`;
  const projectId = cli<{ id: string }>(["project", "create", "--name", project]).id;
  // A second project with look-alike tasks, so a task list that forgets the
  // project gives the wrong answer.
  const otherProjectId = cli<{ id: string }>(["project", "create", "--name", `Backoffice ${n}`]).id;
  const tasks: Record<string, Task> = {};
  for (const [key, title, stage, priority, labels] of SEED) {
    tasks[key] = cli<Task>(
      [
        "task", "create", "--title", title, "--stage", stage, "--priority", priority,
        "--project", projectId, ...labels.flatMap((label) => ["--label", label]),
      ],
      "",
    );
  }
  const others: Array<string> = [];
  for (const [title, stage, labels] of [
    ["Slow checkout in the admin panel", "in-review", ["legacy"]],
    ["Export orders to CSV", "in-review", []],
    ["Fix the flaky login test in admin", "planned", ["triage"]],
  ] as const) {
    others.push(
      cli<Task>(
        ["task", "create", "--title", title, "--stage", stage, "--project", otherProjectId,
          ...labels.flatMap((label) => ["--label", label])],
        "",
      ).id,
    );
  }
  const remote = `https://github.com/acme/webshop-${n}`;
  const resourceId = cli<{ id: string }>(["resource", "create", "--kind", "repo", "--remote", remote, "--project", projectId]).id;
  const pageId = cli<{ id: string }>(
    ["wiki-page", "create", "--resource", resourceId, "--slug", "release-process", "--title", "Release process", "--summary", "How a release is cut"],
    WIKI_BODY,
  ).id;
  // The user creates an initiative, never a session, so the run finds this one already made.
  const initiativeId = cli<{ id: string }>(["initiative", "create", "--name", `Checkout reliability ${n}`, "--project", projectId]).id;
  const world: World = { n, project, projectId, otherProjectId, tasks, resourceId, remote, pageId, initiativeId, cwd: "", cleanup: [] };
  world.cleanup.push(() => {
    const left = cli<{ items: Array<Task> }>(["task", "list", "--project", projectId, "--all"]).items;
    for (const task of left) cli(["task", "delete", task.id]);
    for (const id of others) cli(["task", "delete", id]);
    cli(["resource", "delete", resourceId]);
    cli(["initiative", "delete", initiativeId]);
    cli(["project", "delete", projectId]);
    cli(["project", "delete", otherProjectId]);
  });
  return world;
};

const listProjectTasks = (world: World): Array<Task> =>
  cli<{ items: Array<Task> }>(["task", "list", "--project", world.projectId, "--all"]).items;

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** Returns the seeded tasks that no longer have the stage, priority and labels they were seeded with. */
const listChangedTasks = (world: World, now: ReadonlyArray<Task>, except: ReadonlyArray<string>): Array<string> =>
  Object.entries(world.tasks)
    .filter(([key]) => !except.includes(key))
    .filter(([, before]) => {
      const after = now.find((task) => task.id === before.id);
      return (
        after === undefined ||
        after.stage !== before.stage ||
        after.priority !== before.priority ||
        !sameSet(after.labels, before.labels) ||
        after.initiativeId !== before.initiativeId
      );
    })
    .map(([key]) => key);

interface Check {
  pass: boolean;
  why: string;
}

const check = (problems: ReadonlyArray<string | false>): Check => {
  const found = problems.filter((problem): problem is string => problem !== false);
  return { pass: found.length === 0, why: found.join("; ") };
};

/**
 * Checks a reply that should be a number. The last number in the reply is the
 * answer: a model that shows its sum before the result still answered.
 */
const checkNumber = (reply: string, expected: string): Check => {
  const answer = (reply.match(/\d+/g) ?? []).at(-1);
  return check([answer !== expected && `answered ${String(answer)}, expected ${expected}: ${reply.slice(0, 80)}`]);
};

interface BenchTask {
  id: string;
  prompt: (world: World) => string;
  verify: (world: World, reply: string) => Check;
}

const TASKS: ReadonlyArray<BenchTask> = [
  {
    id: "count",
    prompt: (w) => `How many tasks in the Hercule project "${w.project}" are in review right now? Answer with the number only.`,
    verify: (_w, reply) => {
      return checkNumber(reply, "3");
    },
  },
  {
    id: "create",
    prompt: (w) =>
      `Create a Hercule task in the project "${w.project}". Title: "Rotate the staging API keys". Priority high. Labels: security and ops. The description is two paragraphs. First: "The keys were last rotated in March; it's overdue." Second: "Rotate them, then update the vault entry \`staging/api\` and tell $OPS."`,
    verify: (w) => {
      const made = listProjectTasks(w).filter((task) => task.title === "Rotate the staging API keys");
      const task = made[0];
      if (made.length !== 1 || task === undefined) return check([`${String(made.length)} tasks with that title in the project`]);
      return check([
        task.priority !== "high" && `priority ${task.priority}`,
        !sameSet(task.labels, ["security", "ops"]) && `labels ${task.labels.join(",")}`,
        !task.description.includes("The keys were last rotated in March; it's overdue.") && "first paragraph differs",
        !task.description.includes("Rotate them, then update the vault entry `staging/api` and tell $OPS.") && `second paragraph differs: ${JSON.stringify(task.description)}`,
        !/overdue\.\n\s*\nRotate/.test(task.description) && "paragraphs not separated by a blank line",
        listChangedTasks(w, listProjectTasks(w), []).length > 0 && "changed other tasks",
      ]);
    },
  },
  {
    id: "update",
    prompt: (w) => `In the Hercule project "${w.project}", the task about the flaky login test is ready for review. Move it to in-review, add the label needs-qa and remove the label triage.`,
    verify: (w) => {
      const now = listProjectTasks(w);
      const task = now.find((one) => one.id === w.tasks["login"]!.id);
      if (task === undefined) return check(["the task is gone"]);
      const other = cli<Task>(["task", "read", cli<{ items: Array<Task> }>(["task", "list", "--project", w.otherProjectId, "--text", "flaky login"]).items[0]!.id]);
      return check([
        task.stage !== "in-review" && `stage ${task.stage}`,
        !sameSet(task.labels, ["needs-qa"]) && `labels ${task.labels.join(",")}`,
        (other.stage !== "planned" || !sameSet(other.labels, ["triage"])) && "changed the look-alike task in the other project",
        listChangedTasks(w, now, ["login"]).length > 0 && `changed other tasks: ${listChangedTasks(w, now, ["login"]).join(",")}`,
      ]);
    },
  },
  {
    id: "bulk",
    prompt: (w) => `In the Hercule project "${w.project}", every task labelled legacy that is not done yet is being abandoned: set each of them to stage dropped and priority low. Leave every other task alone.`,
    verify: (w) => {
      const now = listProjectTasks(w);
      const targets = ["legacyCoupons", "legacyCron", "legacyDocs", "legacyFlags"];
      const wrong = targets.filter((key) => {
        const task = now.find((one) => one.id === w.tasks[key]!.id);
        return task === undefined || task.stage !== "dropped" || task.priority !== "low";
      });
      const changed = listChangedTasks(w, now, targets);
      return check([wrong.length > 0 && `not dropped and low: ${wrong.join(",")}`, changed.length > 0 && `changed other tasks: ${changed.join(",")}`]);
    },
  },
  {
    id: "initiative",
    prompt: (w) => `The Hercule project "${w.project}" has an initiative called "Checkout reliability ${w.n}". Put the three tasks about checkout in that project on it.`,
    verify: (w) => {
      const now = listProjectTasks(w);
      const targets = ["checkoutCards", "checkoutSlow", "checkoutGift"];
      const off = targets.filter((key) => now.find((one) => one.id === w.tasks[key]!.id)?.initiativeId !== w.initiativeId);
      const changed = listChangedTasks(w, now, targets);
      return check([
        off.length > 0 && `not on the initiative: ${off.join(",")}`,
        changed.length > 0 && `changed other tasks: ${changed.join(",")}`,
      ]);
    },
  },
  {
    id: "block",
    prompt: (w) => `In the Hercule project "${w.project}", "Ship the new pricing page" cannot land before "Finalize pricing copy" has landed. Record that dependency in Hercule.`,
    verify: (w) => {
      const page = cli<{ blockers: Array<{ id: string }>; blocks: Array<{ id: string }> }>(["task", "details", w.tasks["pricingPage"]!.id]);
      const copy = cli<{ blockers: Array<{ id: string }> }>(["task", "details", w.tasks["pricingCopy"]!.id]);
      return check([
        !JSON.stringify(page.blockers).includes(w.tasks["pricingCopy"]!.id) && "the pricing page does not wait on the copy",
        copy.blockers.length > 0 && "the dependency is recorded the wrong way round",
        listChangedTasks(w, listProjectTasks(w), []).length > 0 && "changed other tasks",
      ]);
    },
  },
  {
    id: "wiki",
    prompt: (w) => `The Hercule wiki of the repository ${w.remote} has a page "release-process". Add a section at the end of that page, with the heading "Rollback" and this one line under it: "Run \`./scripts/rollback.sh <tag>\` and say so in #releases." Keep the rest of the page exactly as it is.`,
    verify: (w) => {
      const { page } = cli<{ page: { body: string; revision: number } }>(["wiki-page", "read", w.pageId]);
      return check([
        page.revision < 2 && "the page was not updated",
        !page.body.startsWith(WIKI_BODY.trimEnd()) && `the existing body changed: ${JSON.stringify(page.body.slice(0, 120))}`,
        !/^#{1,3} Rollback\s*$/m.test(page.body) && "no Rollback heading",
        !page.body.includes("Run `./scripts/rollback.sh <tag>` and say so in #releases.") && `the line differs: ${JSON.stringify(page.body.slice(-120))}`,
      ]);
    },
  },
  {
    id: "profile",
    prompt: (w) => `Create a Hercule permission profile named "reviewer-${w.n}" that carries exactly three grants: the one for reading tasks, the one for reading sessions (it also covers their transcripts), and the one for writing to discussions.`,
    verify: (w) => {
      const found = cli<{ items: Array<{ id: string; name: string; grants: Array<string> }> }>(["profile", "list", "--all"]).items.filter((one) => one.name === `reviewer-${w.n}`);
      const profile = found[0];
      if (found.length !== 1 || profile === undefined) return check([`${String(found.length)} profiles with that name`]);
      w.cleanup.unshift(() => {
        cli(["profile", "delete", profile.id]);
      });
      return check([
        !sameSet(profile.grants, ["task.read", "session.read", "discussion.write"]) && `grants ${profile.grants.join(",")}`,
      ]);
    },
  },
  {
    // The answer is not a filter the API has, so the agent must work it out from the list.
    id: "aggregate",
    prompt: (w) => `In the Hercule project "${w.project}", how many tasks that are neither done nor dropped have no label at all? Answer with the number only.`,
    verify: (_w, reply) => {
      return checkNumber(reply, "7");
    },
  },
  {
    // Moves data from Hercule into a file: a shell pipes it, a tool call returns it to the model.
    id: "export",
    prompt: (w) => `Write the id and the title of every task in the Hercule project "${w.project}" to the file tasks.csv in the current directory, one task per line as id,title.`,
    verify: (w) => {
      let file: string;
      try {
        file = readFileSync(join(w.cwd, "tasks.csv"), "utf8");
      } catch {
        return check(["there is no tasks.csv"]);
      }
      const lines = file.split("\n").filter((line) => line.trim() !== "");
      const missing = Object.entries(w.tasks)
        .filter(([, task]) => !lines.some((line) => line.includes(task.id) && line.includes(task.title)))
        .map(([key]) => key);
      return check([
        missing.length > 0 && `missing: ${missing.join(",")}`,
        lines.length > Object.keys(w.tasks).length + 1 && `${String(lines.length)} lines for ${String(Object.keys(w.tasks).length)} tasks`,
        listChangedTasks(w, listProjectTasks(w), []).length > 0 && "changed tasks",
      ]);
    },
  },
];

/** Builds the `claude` command line and environment of one arm. */
const buildRun = (arm: Arm, prompt: string, cwd: string): { args: Array<string>; env: Record<string, string> } => {
  const env = { ...baseEnv(), HERCULE_SESSION: "1" };
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", MODEL,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
  ];
  if (arm === "cli") {
    env["PATH"] = `${binDir}:${env["PATH"]!}`;
    Object.assign(env, herculeEnv);
    args.push("--append-system-prompt", SESSION_ORIENTATION, "--plugin-dir", pluginDir);
    return { args, env };
  }
  const config = join(cwd, "..", `mcp-${arm}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        hercule: {
          command: "bun",
          args: [join(HERE, "mcp-server.ts")],
          env: { ...herculeEnv, HERCULE_MCP_MODE: arm === "mcp-meta" ? "meta" : "ops" },
        },
      },
    }),
  );
  // Tool search is left as Claude Code ships it, which is what a session gets
  // today: the runner sets nothing. Only the eager arm turns it off.
  if (arm === "mcp-eager") env["ENABLE_TOOL_SEARCH"] = "false";
  args.push("--append-system-prompt", MCP_ORIENTATION[arm], "--mcp-config", config);
  return { args, env };
};

/** Writes a string as a TOML basic string, which is what `codex -c key=value` parses. */
const toml = (value: string): string => JSON.stringify(value);

/**
 * Builds the `codex exec` command line and environment of one arm. The CLI
 * arm gets the orientation and the whole skill as developer instructions,
 * which is how the Codex adapter delivers them.
 */
const buildCodexRun = (arm: Arm, prompt: string, cwd: string): { args: Array<string>; env: Record<string, string> } => {
  const env = { ...baseEnv(), HERCULE_SESSION: "1" };
  const args = [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd,
  ];
  if (MODEL !== "default") args.push("-m", MODEL);
  if (arm === "cli") {
    env["PATH"] = `${binDir}:${env["PATH"]!}`;
    Object.assign(env, herculeEnv);
    args.push("-c", `developer_instructions=${toml(`${SESSION_ORIENTATION}\n\n${HERCULE_SKILL}`)}`);
  } else {
    const mode = arm === "mcp-meta" ? "meta" : "ops";
    args.push(
      "-c", `developer_instructions=${toml(MCP_ORIENTATION[arm])}`,
      "-c", `mcp_servers.hercule.command="bun"`,
      "-c", `mcp_servers.hercule.args=[${toml(join(HERE, "mcp-server.ts"))}]`,
      "-c", `mcp_servers.hercule.env={HERCULE_API_URL=${toml(state.url)},HERCULE_TOKEN=${toml(state.apiKey)},HERCULE_MCP_MODE=${toml(mode)}}`,
    );
  }
  args.push(prompt);
  return { args, env };
};

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface Metrics {
  requests: number;
  /** The context of the first request: what the session carries before it has done anything. */
  firstContext: number;
  /** Input tokens over every request, cached or not: how much the model read in total. */
  inputTotal: number;
  outputTotal: number;
  costUsd: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  /** Calls that only looked something up: `--help`, `hercule_help`, a tool search, opening the skill. */
  lookupCalls: number;
  tools: Record<string, number>;
  reply: string;
  mcpStatus: string;
  calls: Array<string>;
}

/** Reads the metrics of one run from Claude Code's `stream-json` output. */
const readMetrics = (lines: ReadonlyArray<string>): Metrics => {
  const usageByMessage = new Map<string, Usage>();
  const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  let toolErrors = 0;
  let reply = "";
  let costUsd = 0;
  let durationMs = 0;
  let mcpStatus = "";
  let outputFromResult = 0;
  const order: Array<string> = [];
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "system" && event["subtype"] === "init") {
      mcpStatus = JSON.stringify(event["mcp_servers"] ?? []);
    }
    if (event["type"] === "assistant") {
      const message = event["message"] as { id: string; usage: Usage; content: Array<Record<string, unknown>> };
      // A sub-agent's messages carry a parent tool id; only the session's own requests count here.
      if (!usageByMessage.has(message.id)) order.push(message.id);
      usageByMessage.set(message.id, message.usage);
      for (const block of message.content) {
        if (block["type"] === "tool_use") {
          toolUses.set(block["id"] as string, { name: block["name"] as string, input: block["input"] as Record<string, unknown> });
        }
      }
    }
    if (event["type"] === "user") {
      const content = (event["message"] as { content: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block["type"] === "tool_result" && block["is_error"] === true) toolErrors++;
        }
      }
    }
    if (event["type"] === "result") {
      // A streamed message reports the output tokens it had when it started,
      // so only the result's total is the whole count.
      outputFromResult = Number((event["usage"] as Usage | undefined)?.output_tokens ?? 0);
      reply = String(event["result"] ?? "");
      costUsd = Number(event["total_cost_usd"] ?? 0);
      durationMs = Number(event["duration_ms"] ?? 0);
    }
  }
  const sizeOf = (usage: Usage): number =>
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const usages = order.map((id) => usageByMessage.get(id)!);
  const tools: Record<string, number> = {};
  let lookupCalls = 0;
  const calls: Array<string> = [];
  for (const { name, input } of toolUses.values()) {
    tools[name] = (tools[name] ?? 0) + 1;
    const command = typeof input["command"] === "string" ? input["command"] : "";
    calls.push(name === "Bash" ? `Bash: ${command.slice(0, 300)}` : `${name} ${JSON.stringify(input).slice(0, 200)}`);
    if (
      name === "ToolSearch" || name === "Skill" || name.endsWith("hercule_help") ||
      (name === "Bash" && /--help|\bhelp\b/.test(command) && !/\|\s*hercule|hercule[^|;&]*(create|update|post|block|write)/.test(command))
    ) {
      lookupCalls++;
    }
  }
  return {
    requests: usages.length,
    firstContext: usages[0] === undefined ? 0 : sizeOf(usages[0]),
    inputTotal: usages.reduce((sum, usage) => sum + sizeOf(usage), 0),
    outputTotal: outputFromResult,
    costUsd,
    durationMs,
    toolCalls: toolUses.size,
    toolErrors,
    lookupCalls,
    tools,
    reply,
    mcpStatus,
    calls,
  };
};

/**
 * Reads the metrics of one run from the events `codex exec --json` prints.
 * Codex reports usage per turn, not per request, so `requests` and
 * `firstContext` are not known and stay 0.
 */
const readCodexMetrics = (lines: ReadonlyArray<string>): Metrics => {
  let inputTotal = 0;
  let outputTotal = 0;
  let cached = 0;
  let reply = "";
  let toolErrors = 0;
  let lookupCalls = 0;
  const tools: Record<string, number> = {};
  const calls: Array<string> = [];
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "turn.completed") {
      const usage = event["usage"] as Record<string, number>;
      inputTotal += usage["input_tokens"] ?? 0;
      cached += usage["cached_input_tokens"] ?? 0;
      outputTotal += usage["output_tokens"] ?? 0;
    }
    if (event["type"] !== "item.completed") continue;
    const item = event["item"] as Record<string, unknown>;
    if (item["type"] === "agent_message") reply = String(item["text"] ?? "");
    if (item["type"] === "command_execution") {
      const command = String(item["command"] ?? "");
      tools["shell"] = (tools["shell"] ?? 0) + 1;
      calls.push(`shell: ${command.slice(0, 300)}`);
      if (item["exit_code"] !== 0) toolErrors++;
      if (/--help/.test(command) && !/(create|update|post|block|write) /.test(command)) lookupCalls++;
    }
    if (item["type"] === "mcp_tool_call") {
      const name = String(item["tool"] ?? "");
      tools[name] = (tools[name] ?? 0) + 1;
      calls.push(`${name} ${JSON.stringify(item["arguments"] ?? {}).slice(0, 200)}`);
      const result = item["result"] as { is_error?: boolean } | null | undefined;
      if (item["status"] === "failed" || item["error"] != null || result?.is_error === true) toolErrors++;
      if (name === "hercule_help") lookupCalls++;
    }
  }
  return {
    requests: 0,
    firstContext: 0,
    inputTotal,
    outputTotal,
    costUsd: 0,
    durationMs: 0,
    toolCalls: calls.length,
    toolErrors,
    lookupCalls,
    tools,
    reply,
    mcpStatus: `cached=${String(cached)}`,
    calls,
  };
};

/** Runs one task in one arm, checks the result, and appends a row to the results file. */
const runOne = async (arm: Arm, task: BenchTask, rep: number): Promise<void> => {
  const world = seedWorld();
  const scratch = mkdtempSync(join(tmpdir(), "hercule-mcp-bench-run-"));
  const cwd = join(scratch, "work");
  mkdirSync(cwd);
  world.cwd = cwd;
  const { args, env } =
    HARNESS === "codex" ? buildCodexRun(arm, task.prompt(world), cwd) : buildRun(arm, task.prompt(world), cwd);
  const started = Date.now();
  const output = await new Promise<string>((resolve) => {
    const child = spawn(HARNESS, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  const metrics = (HARNESS === "codex" ? readCodexMetrics : readMetrics)(output.split("\n"));
  let verdict: Check;
  try {
    verdict = task.verify(world, metrics.reply);
  } catch (error) {
    verdict = { pass: false, why: `check failed to run: ${String(error).slice(0, 300)}` };
  }
  for (const step of world.cleanup) {
    try {
      step();
    } catch {
      // A leftover row only adds noise to later runs; it never changes a result.
    }
  }
  writeFileSync(join(dirname(resultsFile), "logs", `${HARNESS}-${arm}-${task.id}-${String(rep)}-${MODEL}.jsonl`), output);
  rmSync(scratch, { recursive: true, force: true });
  appendFileSync(
    resultsFile,
    `${JSON.stringify({ harness: HARNESS, model: MODEL, arm, task: task.id, rep, ...verdict, wallMs: Date.now() - started, ...metrics })}\n`,
  );
  console.log(`${arm.padEnd(11)} ${task.id.padEnd(11)} #${String(rep)} ${verdict.pass ? "pass" : "FAIL"} requests=${String(metrics.requests)} first=${String(metrics.firstContext)} in=${String(metrics.inputTotal)} out=${String(metrics.outputTotal)} $${metrics.costUsd.toFixed(3)} ${verdict.why}`);
};

mkdirSync(join(dirname(resultsFile), "logs"), { recursive: true });
const arms = readFlag("arms", DEFAULT_ARMS.join(",")).split(",") as Array<Arm>;
const taskIds = readFlag("tasks", TASKS.map((task) => task.id).join(",")).split(",");
const queue: Array<() => Promise<void>> = [];
// Arms are interleaved inside each repetition, so whatever drifts over the
// length of the measurement drifts for every arm alike.
for (let rep = 1; rep <= REPS; rep++) {
  for (const task of TASKS.filter((one) => taskIds.includes(one.id))) {
    for (const arm of arms) queue.push(() => runOne(arm, task, rep));
  }
}
console.log(`${String(queue.length)} runs, ${HARNESS}, model ${MODEL}, ${String(PARALLEL)} at a time`);
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next();
  }),
);
rmSync(shared, { recursive: true, force: true });
