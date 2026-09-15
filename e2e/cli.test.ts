/**
 * Tasks, projects, the event log and the shipped plugins out of the release
 * binary.
 *
 * Tasks, projects and the event log add no CLI code of their own: the commands
 * are derived from the contract's CLI table, so the only way to know they are
 * really there is to run the thing a release ships. The plugin registry is compiled in the same way,
 * so what a release boots with is only visible from a release. This suite runs
 * `./hydra` as the controller and as the CLI, which is why it is out of
 * `pnpm test`: `pnpm build:binary` first, then `pnpm test:binary`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  apiKeyIn,
  cli,
  completeSetup,
  jsonOf,
  startController,
  temporaryHome,
  type Controller,
} from "./harness";

const state = temporaryHome();
const binary = join(ROOT, "hydra");

let controller: Controller;
let url: string;

/** The CLI, as the binary, under the credential file the login wrote. */
const hydra = (args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: state.home, binary, stdin });

/** Fails with the command's own output rather than on an undefined field. */
const ok = (ran: { code: number; stdout: string; stderr: string }): unknown => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return jsonOf(ran);
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

  const login = await hydra(
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
    const project = ok(await hydra(["project", "create", "--name", "hydra", "--json"])) as {
      id: string;
      name: string;
    };
    expect(project.name).toBe("hydra");

    const created = ok(
      await hydra(
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

    // A task that matches neither filter, so a listing that answers with both
    // rows would fail here rather than pass by accident.
    ok(await hydra(["task", "create", "--title", "unrelated", "--json"], ""));

    const queried = ok(
      await hydra(["task", "list", "--status", "open", "--label", "x", "--json"]),
    ) as { items: ReadonlyArray<TaskRow> };
    expect(queried.items.map((task) => task.id)).toEqual([created.id]);

    const byTail = ok(await hydra(["task", "read", created.id.slice(-8), "--json"])) as TaskRow;
    expect(byTail.id).toBe(created.id);

    const updated = ok(
      await hydra(["task", "update", created.id, "--status", "in-progress", "--json"]),
    ) as TaskRow;
    expect(updated.status).toBe("in-progress");

    const deleted = await hydra(["task", "delete", created.id, "--json"]);
    expect(deleted.code).toBe(0);

    const gone = await hydra(["task", "read", created.id, "--json"]);
    expect(gone.code).toBe(1);
    expect(jsonOf(gone)).toMatchObject({ error: { code: "not_found" } });

    const projects = ok(await hydra(["project", "list", "--json"])) as {
      items: ReadonlyArray<{ id: string; name: string }>;
    };
    expect(projects.items.map((one) => one.name)).toContain("hydra");
  }, 60_000);

  it("shows the task events the commands wrote, each stamped with the user", async () => {
    const events = ok(await hydra(["event", "list", "--kind", "task.created", "--json"])) as {
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
    // No CLI command for plugins, so the route is called the way the web app
    // does: the key the login above minted, straight over the wire.
    const response = await fetch(`${url}/api/v1/plugins`, {
      headers: { authorization: `Bearer ${apiKeyIn(state.home)}` },
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
    // The three harnesses are providers; github is the connection type.
    expect(plugins.at(-1)?.capabilities).toEqual(["connections"]);
  }, 30_000);

  it("lists the five task verbs in help, each with its grant and a line of its own", async () => {
    const help = await hydra(["task", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("usage: hydra task <verb>");
    for (const verb of ["list", "read", "create", "update", "delete"]) {
      // Each verb in its positional shape, with the grant it needs: what the
      // tree built from the contract's CLI table produced.
      expect(help.stdout).toMatch(new RegExp(`^ {2}${verb}( <id>)? +grant task\\.`, "m"));
    }

    // `create` is the row the criterion names: its grant on the verb line, and
    // one line of what it does under it.
    const lines = help.stdout.split("\n");
    const create = lines.findIndex((line) => /^ {2}create +grant task\.create$/.test(line));
    expect(create, help.stdout).toBeGreaterThanOrEqual(0);
    expect(lines[create + 1]).toMatch(/^ {6}\S.*\.$/);
  }, 30_000);

  it("ends the help of one command with its operation, route and grant", async () => {
    const help = await hydra(["task", "create", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout.trimEnd().split("\n").at(-1)).toBe(
      "operation task.create · POST /api/v1/tasks · grant task.create",
    );
  }, 30_000);
});
