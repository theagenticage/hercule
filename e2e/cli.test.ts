/**
 * Tests tasks, projects, the event log, the shipped plugins and assistants
 * through the release binary.
 *
 * Tasks, projects and the event log add no CLI code of their own: the commands
 * are derived from the contract's CLI table, so the only way to know they are
 * really there is to run what a release ships. The plugin registry is compiled
 * in too, so what a release starts with is only visible from a release. This
 * suite runs `./hercule` as the controller and as the CLI, which is why it is
 * out of `pnpm test`: `pnpm build:binary` first, then `pnpm test:binary`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  runCli,
  completeSetup,
  startController,
  type Controller,
} from "../scripts/controller-process";
import { readApiKey, listInstances, parseJsonOutput, createTemporaryHome } from "./harness";

const state = createTemporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;

/** Runs the CLI binary with the credential file the login wrote. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/**
 * Parses a command's JSON output. Fails with the command's own output, rather
 * than later on an undefined field.
 */
const expectJsonOutput = (ran: { code: number; stdout: string; stderr: string }): unknown => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return parseJsonOutput(ran);
};

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly labels: ReadonlyArray<string>;
  readonly projectId?: string;
}

beforeAll(async () => {
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  controller = await startController({ home: state.home, binary });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await runLoggedInCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-cli"],
    PASSWORD,
  );
  expect(login.code).toBe(0);
}, 90_000);

afterAll(async () => {
  await controller.stop().catch(() => -1);
  state.remove();
});

describe("tasks, projects, the log and the plugins through the binary", () => {
  it("creates, lists, reads, updates and deletes a task", async () => {
    const project = expectJsonOutput(
      await runLoggedInCli(["project", "create", "--name", "hercule", "--json"]),
    ) as {
      id: string;
      name: string;
    };
    expect(project.name).toBe("hercule");

    const created = expectJsonOutput(
      await runLoggedInCli(
        [
          "task",
          "create",
          "--title",
          "wire the runner up",
          "--label",
          "x",
          "--project",
          project.id,
          "--json",
        ],
        "the first task the binary made",
      ),
    ) as TaskRow;
    expect(created).toMatchObject({
      title: "wire the runner up",
      status: "open",
      labels: ["x"],
      projectId: project.id,
    });

    // A task that matches neither filter, so a list that returns both rows
    // would fail here rather than pass by accident.
    expectJsonOutput(
      await runLoggedInCli(["task", "create", "--title", "unrelated", "--json"], ""),
    );

    const queried = expectJsonOutput(
      await runLoggedInCli(["task", "list", "--status", "open", "--label", "x", "--json"]),
    ) as { items: ReadonlyArray<TaskRow> };
    expect(queried.items.map((task) => task.id)).toEqual([created.id]);

    const byTail = expectJsonOutput(
      await runLoggedInCli(["task", "read", created.id.slice(-8), "--json"]),
    ) as TaskRow;
    expect(byTail.id).toBe(created.id);

    const updated = expectJsonOutput(
      await runLoggedInCli(["task", "update", created.id, "--status", "in-progress", "--json"]),
    ) as TaskRow;
    expect(updated.status).toBe("in-progress");

    const deleted = await runLoggedInCli(["task", "delete", created.id, "--json"]);
    expect(deleted.code).toBe(0);

    const gone = await runLoggedInCli(["task", "read", created.id, "--json"]);
    expect(gone.code).toBe(1);
    expect(parseJsonOutput(gone)).toMatchObject({ error: { code: "not_found" } });

    const projects = expectJsonOutput(await runLoggedInCli(["project", "list", "--json"])) as {
      items: ReadonlyArray<{ id: string; name: string }>;
    };
    expect(projects.items.map((one) => one.name)).toContain("hercule");
  }, 60_000);

  it("shows the task events the commands wrote, each stamped with the user", async () => {
    const events = expectJsonOutput(
      await runLoggedInCli(["event", "list", "--kind", "task.created", "--json"]),
    ) as {
      items: ReadonlyArray<{ id: number; kind: string; actor: string | null }>;
    };
    expect(events.items.length).toBeGreaterThanOrEqual(2);
    for (const row of events.items) {
      expect(row.kind).toBe("task.created");
      expect(row.actor).toBe("user");
      expect(Number.isInteger(row.id)).toBe(true);
    }
  }, 30_000);

  it("lists the four shipped plugins, each one active", async () => {
    // There is no CLI command for this, so the route is called the way the
    // web app calls it: over HTTP, with the key the login above created.
    const response = await fetch(`${url}/api/v1/plugins`, {
      headers: { authorization: `Bearer ${readApiKey(state.home)}` },
    });
    expect(response.status).toBe(200);

    const plugins = (await response.json()) as ReadonlyArray<{
      id: string;
      capabilities: ReadonlyArray<string>;
      status: { _tag: string };
    }>;
    expect(plugins.map((plugin) => plugin.id)).toEqual(["claude-code", "codex", "pi", "github"]);
    for (const plugin of plugins) {
      expect(plugin.status, plugin.id).toEqual({ _tag: "active" });
    }
    // The three harnesses are providers; github is the connection type and
    // the event source that declares the GitHub event kinds.
    expect(plugins.at(-1)?.capabilities).toEqual(["connections", "event-sources"]);
  }, 30_000);

  it("lists the five task verbs in help, each with its grant and a line of its own", async () => {
    const help = await runLoggedInCli(["task", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("usage: hercule task <verb>");
    for (const verb of ["list", "read", "create", "update", "delete"]) {
      // Each verb with its positional arguments and the grant it needs, as the
      // command tree built from the contract's CLI table shows it.
      expect(help.stdout).toMatch(new RegExp(`^ {2}${verb}( <id>)? +grant task\\.`, "m"));
    }

    // For `create`, check the grant on the verb line, and one line describing
    // what it does under it.
    const lines = help.stdout.split("\n");
    const create = lines.findIndex((line) => /^ {2}create +grant task\.create$/.test(line));
    expect(create, help.stdout).toBeGreaterThanOrEqual(0);
    expect(lines[create + 1]).toMatch(/^ {6}\S.*\.$/);
  }, 30_000);

  it("ends the help of one command with its operation, route and grant", async () => {
    const help = await runLoggedInCli(["task", "create", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout.trimEnd().split("\n").at(-1)).toBe(
      "operation task.create · POST /api/v1/tasks · grant task.create",
    );
  }, 30_000);
});

interface AssistantRow {
  readonly id: string;
  readonly name: string;
  readonly instanceId: string;
  readonly reply: string;
}

describe("assistants through the binary", () => {
  it("lists the default assistant, then a created one after it, each with its instance and reply mode", async () => {
    const first = expectJsonOutput(await runLoggedInCli(["assistant", "list", "--json"])) as {
      items: ReadonlyArray<AssistantRow>;
    };
    expect(first.items.map((assistant) => assistant.name)).toEqual(["Hercule"]);

    const created = expectJsonOutput(
      await runLoggedInCli(["assistant", "create", "--name", "Ada", "--json"]),
    ) as AssistantRow;
    expect(created.name).toBe("Ada");

    const second = expectJsonOutput(await runLoggedInCli(["assistant", "list", "--json"])) as {
      items: ReadonlyArray<AssistantRow>;
    };
    expect(second.items.map((assistant) => assistant.name)).toEqual(["Hercule", "Ada"]);
    const instances = await listInstances({ url, apiKey: readApiKey(state.home) });
    for (const assistant of second.items) {
      expect(
        instances.map((instance) => instance.id),
        assistant.name,
      ).toContain(assistant.instanceId);
      expect(assistant.reply, assistant.name).toBe("turn-end");
    }

    // The table a person reads shows the same: one row per assistant, oldest
    // first, with the tail of its instance and its reply mode.
    const table = await runLoggedInCli(["assistant", "list"]);
    expect(table.code, table.stderr).toBe(0);
    const rows = table.stdout.split("\n").filter((line) => /Hercule|Ada/.test(line));
    expect(rows).toHaveLength(2);
    for (const [index, assistant] of second.items.entries()) {
      expect(rows[index], assistant.name).toContain(assistant.name);
      expect(rows[index], assistant.name).toContain(assistant.instanceId.slice(-8));
      expect(rows[index], assistant.name).toContain("turn-end");
    }
  }, 60_000);

  it("reads the default assistant with its reply mode", async () => {
    const listed = expectJsonOutput(await runLoggedInCli(["assistant", "list", "--json"])) as {
      items: ReadonlyArray<AssistantRow>;
    };
    const hercule = listed.items.find((assistant) => assistant.name === "Hercule");
    expect(hercule).toBeDefined();

    const read = await runLoggedInCli(["assistant", "read", hercule!.id]);
    expect(read.code, `${read.stdout}\n${read.stderr}`).toBe(0);
    expect(read.stdout).toMatch(/^name\s+Hercule$/m);
    expect(read.stdout).toMatch(/^reply\s+turn-end$/m);
  }, 30_000);
});
