/**
 * Tasks, projects and the event log out of the release binary.
 *
 * Tasks, projects and the event log add no CLI code: the commands are derived
 * from the contract, so the only way to know they are really there is to run
 * the thing a release ships. This suite runs `./hydra` as the controller and as
 * the CLI, which is why it is out of `pnpm test`: `pnpm build:binary` first,
 * then `pnpm test:binary`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, cli, jsonOf, startController, temporaryHome, type Controller } from "./harness";

const PASSWORD = "correct horse battery staple";
const USERNAME = "rogier";

const state = temporaryHome();
const binary = join(ROOT, "hydra");

let controller: Controller;
let url: string;

/** The CLI, as the binary, under the credential file the login wrote. */
const hydra = (args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: state.home, binary, stdin });

/** The CLI before a credential file exists: only the environment says where. */
const beforeLogin = (args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: state.home, binary, env: { HYDRA_API_URL: url }, stdin });

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

  const setupUrl = readFileSync(join(state.home, "setup-url"), "utf8").trim();
  const token = new URL(setupUrl).searchParams.get("token");
  const completed = await beforeLogin(
    [
      "setup",
      "complete",
      "--setup-token",
      token!,
      "--username",
      USERNAME,
      "--password-stdin",
      "--timezone",
      "Europe/Amsterdam",
      "--json",
    ],
    PASSWORD,
  );
  expect(completed.code).toBe(0);

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

describe("tasks, projects and the log through the binary", () => {
  it("creates, queries, reads, updates and deletes a task", async () => {
    const project = ok(await hydra(["project", "create", "--name", "hydra", "--json"])) as {
      id: string;
      name: string;
    };
    expect(project.name).toBe("hydra");

    const created = ok(
      await hydra([
        "task",
        "create",
        "--title",
        "wire the runner up",
        "--description",
        "the first task the binary made",
        "--labels",
        "x",
        "--projectId",
        project.id,
        "--json",
      ]),
    ) as TaskRow;
    expect(created).toMatchObject({
      title: "wire the runner up",
      status: "open",
      labels: ["x"],
      projectId: project.id,
    });

    // A task that matches neither filter, so a query that answers with both
    // rows would fail here rather than pass by accident.
    ok(await hydra(["task", "create", "--title", "unrelated", "--description", "", "--json"]));

    const queried = ok(
      await hydra(["task", "query", "--status", "open", "--labels", "x", "--json"]),
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

    const projects = ok(await hydra(["project", "query", "--json"])) as {
      items: ReadonlyArray<{ id: string; name: string }>;
    };
    expect(projects.items.map((one) => one.name)).toContain("hydra");
  }, 60_000);

  it("shows the task events the commands wrote, each stamped with the user", async () => {
    const events = ok(await hydra(["event", "query", "--kind", "task.created", "--json"])) as {
      items: ReadonlyArray<{ id: number; kind: string; actor: string | null }>;
    };
    expect(events.items.length).toBeGreaterThanOrEqual(2);
    for (const row of events.items) {
      expect(row.kind).toBe("task.created");
      expect(row.actor).toBe("user");
      expect(Number.isInteger(row.id)).toBe(true);
    }
  }, 30_000);

  it("lists the five task verbs in help, with no CLI code behind them", async () => {
    const help = await hydra(["task", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("usage: hydra task <verb>");
    for (const verb of ["query", "read", "create", "update", "delete"]) {
      // Each verb, with the grant it needs: what the derived tree produced.
      expect(help.stdout).toMatch(new RegExp(`^ {2}${verb} +grant task\\.`, "m"));
    }
  }, 30_000);
});
