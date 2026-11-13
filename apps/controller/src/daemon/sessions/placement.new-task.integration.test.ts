/**
 * Tests `session.spawn` with `newTask` (spec 09, "A Thread started on things"):
 * the Thread starts on a new Task made from External Entities, in the one
 * transaction that stores the session.
 *
 * The tests use the real API, the real runner socket and real rows. The
 * things are rows of the invented northwind plugin, each read by one account.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Session, Task } from "@hercule/contract";
import type { TextGenerationOutcome } from "@hercule/protocol";
import {
  arrangeThing,
  buildNorthwind,
  CHANGE_KIND,
  createAccount,
  TICKET_KIND,
  type Thing,
} from "../../external-entities/testing";
import { withTransaction } from "../../db";
import { get, post, send } from "../../http/testing";
import {
  createProfile,
  findProviderAccountId,
  readSession,
  spawnThreadUnder,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import { createRepo, reportWorkspaceReady, withFleet } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const runSql = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

/** Runs `body` against a fleet that also runs the northwind plugin, with one account that reads the things. */
const withThings = (body: (arranged: Arranged, account: string) => Promise<void>): Promise<void> =>
  withFleet(
    async (arranged) => {
      const account = await createAccount(
        { harness: arranged.harness, base: arranged.harness.base, token: arranged.token },
        "token",
      );
      await body(arranged, account);
    },
    { plugins: [buildNorthwind().plugin] },
  );

/** Arranges a thing the account reads. */
const arrange = (
  arranged: Arranged,
  account: string,
  key: string,
  kind: typeof CHANGE_KIND | typeof TICKET_KIND = TICKET_KIND,
): Promise<Thing> =>
  arrangeThing(
    { harness: arranged.harness, base: arranged.harness.base, token: arranged.token },
    { kind, key, title: `Thing ${key}`, accounts: [account] },
  );

/** Spawns as `token` (the user unless given) and returns the raw response. */
const spawn = (
  arranged: Arranged,
  fields: Record<string, unknown>,
  token = arranged.token,
): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/sessions", { prompt: "work on it", ...fields }, token);

const spawnOk = async (arranged: Arranged, fields: Record<string, unknown>): Promise<Session> => {
  const response = await spawn(arranged, fields);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/** Reads the error of a failed response: its HTTP status, its code, its message and the issues of a decoding failure. */
const readError = async (response: Response) => {
  const body = (await response.json()) as {
    error: {
      code: string;
      message: string;
      details?: { issues: ReadonlyArray<{ path: ReadonlyArray<string>; message: string }> };
    };
  };
  return {
    status: response.status,
    code: body.error.code,
    message: body.error.message,
    issues: body.error.details?.issues ?? [],
  };
};

/** Runs a write in a transaction: the harness's own connection reads only, and a transaction takes the writer. */
const runWrite = <A>(arranged: Arranged, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  runSql(
    withTransaction(
      arranged.harness.sql,
      Effect.provideService(effect, SqlClient.SqlClient, arranged.harness.sql),
    ),
  );

const readTask = async (arranged: Arranged, id: string): Promise<Task> => {
  const response = await get(arranged.harness.base, `/api/v1/tasks/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

/** Counts the rows of the tables a spawn writes. */
const countRows = async (arranged: Arranged) => {
  const count = async (table: "tasks" | "sessions" | "task_entity_links") => {
    const [row] = await runSql(
      arranged.harness.sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM ${arranged.harness.sql(table)}`,
    );
    return row!.n;
  };
  return {
    tasks: await count("tasks"),
    sessions: await count("sessions"),
    links: await count("task_entity_links"),
  };
};

/** Lists the links of a Task as `ref taken_by`, with whether they were marked taken, sorted. */
const listLinks = async (arranged: Arranged, taskId: string) =>
  (
    await runSql(
      arranged.harness.sql<{
        readonly ref: string;
        readonly taken_at: string | null;
        readonly taken_by: string | null;
      }>`SELECT ref, taken_at, taken_by FROM task_entity_links
         WHERE task_id = unhex(${taskId.replaceAll("-", "")}) ORDER BY ref`,
    )
  ).map((row) => ({ ref: row.ref, taken: row.taken_at !== null, by: row.taken_by }));

describe("session.spawn with newTask", () => {
  it("makes one Task from the things, takes each on, and starts the Thread on it", async () => {
    await withThings(async (arranged, account) => {
      const first = await arrange(arranged, account, "WEB-1");
      const second = await arrange(arranged, account, "WEB-2");
      const before = await countRows(arranged);

      const session = await spawnOk(arranged, {
        newTask: { title: "Fix the refund flow", entityIds: [first.id, second.id] },
      });

      expect(await countRows(arranged)).toEqual({
        tasks: before.tasks + 1,
        sessions: before.sessions + 1,
        links: before.links + 2,
      });
      const task = await readTask(arranged, session.taskId!);
      expect(task).toMatchObject({ title: "Fix the refund flow", stage: "exploring" });
      expect(await listLinks(arranged, task.id)).toEqual([
        { ref: first.ref, taken: true, by: "user" },
        { ref: second.ref, taken: true, by: "user" },
      ]);
      const created = await arranged.harness.platformEvents("task.created");
      expect(created.at(-1)?.actor).toBe("user");
    });
  });

  it("keeps the title the user chose when the Thread's generated title arrives", async () => {
    await withThings(async (arranged, account) => {
      const outcome: TextGenerationOutcome = {
        outcome: "ok",
        value: { title: "A generated title", needsRefinement: false, role: "fix" },
        usage: null,
      };
      arranged.wire.setTextGenerationAnswer(() => outcome);
      const chosen = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: {
          controller: {
            "textGeneration.model": {
              providerAccountId: findProviderAccountId(arranged, "harnesses/test"),
              model: "clever",
            },
          },
        },
        token: arranged.token,
      });
      expect(chosen.status, await chosen.clone().text()).toBe(200);
      const thing = await arrange(arranged, account, "WEB-1");

      const session = await spawnOk(arranged, {
        newTask: { title: "My own title", entityIds: [thing.id] },
      });

      await waitUntil("generated the Thread's title", async () =>
        (await readSession(arranged, session.id)).title === "A generated title" ? true : undefined,
      );
      expect((await readTask(arranged, session.taskId!)).title).toBe("My own title");
    });
  });

  it("returns the first session for a repeat with the same dedupKey, and makes no second Task", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      const fields = {
        newTask: { title: "Once", entityIds: [thing.id] },
        dedupKey: "start-from-inbox",
      };
      const first = await spawnOk(arranged, fields);
      const afterFirst = await countRows(arranged);

      // The thing is on the first call's Task now, so a call that was not
      // recognised as a repeat would be refused with a conflict.
      const second = await spawnOk(arranged, fields);

      expect(second.id).toBe(first.id);
      expect(await countRows(arranged)).toEqual(afterFirst);
    });
  });

  it("returns the first session for a repeat even when the thing can no longer be read", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      const fields = {
        newTask: { title: "Once", entityIds: [thing.id] },
        dedupKey: "response-lost",
      };
      const first = await spawnOk(arranged, fields);
      const afterFirst = await countRows(arranged);
      // The thing is a partial record that no account reads now, so preparing
      // it would fail with invalid_state if the repeat got that far.
      await runWrite(
        arranged,
        arranged.harness
          .sql`UPDATE external_entities SET completeness = 'partial' WHERE ref = ${thing.ref}`,
      );
      await runWrite(
        arranged,
        arranged.harness
          .sql`UPDATE external_entity_observations SET access = 'inaccessible' WHERE ref = ${thing.ref}`,
      );

      const second = await spawnOk(arranged, fields);

      expect(second.id).toBe(first.id);
      expect(await countRows(arranged)).toEqual(afterFirst);
    });
  });

  it("refuses an unknown thing with not_found, and writes nothing", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, {
          newTask: {
            title: "Never made",
            entityIds: [thing.id, "0199f0b7-0000-7000-8000-00000000dead"],
          },
        }),
      );

      expect(failure).toMatchObject({ status: 404, code: "not_found" });
      expect(failure.message).toContain("0199f0b7-0000-7000-8000-00000000dead");
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it("refuses a thing that is already on an active Task with a conflict naming both, and writes nothing", async () => {
    await withThings(async (arranged, account) => {
      const taken = await arrange(arranged, account, "WEB-1");
      const free = await arrange(arranged, account, "WEB-2");
      const takeOn = await post(
        arranged.harness.base,
        `/api/v1/external-entities/${taken.id}/take-on`,
        {},
        arranged.token,
      );
      expect(takeOn.status, await takeOn.clone().text()).toBe(200);
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, {
          newTask: { title: "Never made", entityIds: [free.id, taken.id] },
        }),
      );

      expect(failure).toMatchObject({ status: 409, code: "conflict" });
      expect(failure.message).toContain(taken.ref);
      expect(failure.message).toContain("Thing WEB-1");
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it("refuses a thing Hercule holds only in part when the read at its source fails, and writes nothing", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      await runWrite(
        arranged,
        arranged.harness
          .sql`UPDATE external_entities SET completeness = 'partial' WHERE ref = ${thing.ref}`,
      );
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, { newTask: { title: "Never made", entityIds: [thing.id] } }),
      );

      expect(failure).toMatchObject({ status: 409, code: "invalid_state" });
      expect(failure.message).toContain(thing.ref);
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it("refuses a thing no account can read now when the read at its source fails, and writes nothing", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      await runWrite(
        arranged,
        arranged.harness
          .sql`UPDATE external_entity_observations SET access = 'inaccessible' WHERE ref = ${thing.ref}`,
      );
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, { newTask: { title: "Never made", entityIds: [thing.id] } }),
      );

      expect(failure).toMatchObject({ status: 409, code: "invalid_state" });
      expect(failure.message).toContain(thing.ref);
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it("refuses a session that starts a Thread on a new Task, and writes nothing", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      const caller = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "thread-starter", [
          "session.spawn",
          "thread.start",
          "task.update",
        ]),
      );
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(
          arranged,
          { newTask: { title: "Never made", entityIds: [thing.id] } },
          caller.token,
        ),
      );

      expect(failure).toMatchObject({ status: 403, code: "forbidden" });
      expect(failure.message).toContain("ask the user");
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it.each([
    ["taskId", { taskId: "0199f0b7-0000-7000-8000-00000000dead" }],
    ["agentId", { agentId: "0199f0b7-0000-7000-8000-00000000dead" }],
  ])("refuses newTask together with %s when the call is decoded", async (_name, other) => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, {
          newTask: { title: "Never made", entityIds: [thing.id] },
          ...other,
        }),
      );

      expect(failure).toMatchObject({ status: 400, code: "validation" });
      expect(failure.issues).toMatchObject([
        { path: ["newTask"], message: expect.stringContaining("taskId or agentId") as unknown },
      ]);
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it.each([
    ["no things", []],
    [
      "a repeated thing",
      ["0199f0b7-0000-7000-8000-000000000001", "0199f0b7-0000-7000-8000-000000000001"],
    ],
  ])("refuses a newTask with %s when the call is decoded", async (_name, entityIds) => {
    await withThings(async (arranged) => {
      const failure = await readError(
        await spawn(arranged, { newTask: { title: "Never made", entityIds } }),
      );

      expect(failure).toMatchObject({ status: 400, code: "validation" });
    });
  });

  it("joins the new Task in a workspace that already belongs to another Task, and leaves the workspace's owner as it is", async () => {
    await withThings(async (arranged, account) => {
      const repo = await createRepo(arranged, "https://github.com/acme/web");
      const owner = await spawnOk(arranged, {
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: repo }] },
      });
      await reportWorkspaceReady(arranged, String(owner.workspaceId));
      const thing = await arrange(arranged, account, "WEB-1");

      const session = await spawnOk(arranged, {
        newTask: { title: "Started in an old folder", entityIds: [thing.id] },
        workspace: { kind: "existing", workspaceId: String(owner.workspaceId) },
      });

      expect(session.workspaceId).toBe(owner.workspaceId);
      expect(session.taskId).not.toBe(owner.taskId);
      expect((await readTask(arranged, session.taskId!)).title).toBe("Started in an old folder");
      const [row] = await runSql(
        arranged.harness.sql<{ readonly task_id: string }>`
          SELECT lower(hex(task_id)) AS task_id FROM task_workspaces
          WHERE workspace_id = unhex(${String(owner.workspaceId).replaceAll("-", "")})`,
      );
      expect(row?.task_id).toBe(owner.taskId!.replaceAll("-", ""));
    });
  });
});
