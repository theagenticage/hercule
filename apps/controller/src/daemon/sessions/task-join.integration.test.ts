/**
 * Tests the rule that gives a Thread its Task (spec 09, "Which Task a session
 * gets", "A workspace's Task" and "Taking a Thread off Done"), through the
 * operations that write or reopen a session: `session.spawn`,
 * `session.continue`, `session.reopen` and a new input.
 *
 * The tests use the real API, the real runner socket and real rows. Each row of
 * a table arranges the rows the rule reads, starts one session, and then
 * checks three things the rule decides: which Task the session ended up on,
 * which Tasks and `task.created` events the start added, and which rows
 * `task_workspaces` holds afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Session, SessionSpawnInput, Task } from "@hercule/contract";
import type { TextGenerationOutcome, TextGenerationRequest } from "@hercule/protocol";
import { withTransaction } from "../../db";
import { del, get, post, send } from "../../http/testing";
import { sessionRepository } from "../../sessions";
import {
  at,
  createProfile,
  findProviderAccountId,
  readSession,
  reportEvent,
  reportTurnCompleted,
  reportTurnStarted,
  spawnThreadUnder,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import { createRepo, reportWorkspaceReady, withFleet } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/* ------------------------------------------------------------------------ */
/* Helpers: the API calls the rows arrange with.                             */
/* ------------------------------------------------------------------------ */

/** Returns the body of a 200 response, and fails the test on any other status. */
const readOk = async <A>(response: Response): Promise<A> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as A;
};

/** Creates a Task through the API, as the user. */
const createTask = async (arranged: Arranged, title: string): Promise<Task> =>
  readOk(
    await post(arranged.harness.base, "/api/v1/tasks", { title, description: "" }, arranged.token),
  );

const readTask = async (arranged: Arranged, id: string): Promise<Task> =>
  readOk(await get(arranged.harness.base, `/api/v1/tasks/${id}`, arranged.token));

const updateTask = async (
  arranged: Arranged,
  id: string,
  body: Record<string, unknown>,
): Promise<Task> =>
  readOk(
    await send("PATCH", arranged.harness.base, `/api/v1/tasks/${id}`, {
      body,
      token: arranged.token,
    }),
  );

const finishTask = (arranged: Arranged, id: string): Promise<Task> =>
  updateTask(arranged, id, { stage: "done" });

/** Spawns a session as the holder of `token`, the user unless given. */
const spawnOk = async (
  arranged: Arranged,
  fields: Record<string, unknown> = {},
  token = arranged.token,
): Promise<Session> =>
  readOk(
    await post(
      arranged.harness.base,
      "/api/v1/sessions",
      { prompt: "work on it", ...fields },
      token,
    ),
  );

/** Spawns a Thread in a new ephemeral workspace and waits until the workspace is ready. */
const spawnInNewWorkspace = async (
  arranged: Arranged,
  repo: string,
  fields: Record<string, unknown> = {},
): Promise<Session> => {
  const session = await spawnOk(arranged, {
    workspace: { kind: "ephemeral", checkouts: [{ resourceId: repo }] },
    ...fields,
  });
  await reportWorkspaceReady(arranged, String(session.workspaceId));
  return session;
};

/** Builds the spawn field that puts a session in a workspace that already exists. */
const buildExistingWorkspace = (session: Session) => ({
  kind: "existing" as const,
  workspaceId: String(session.workspaceId),
});

/** Spawns a session, lets it start, then ends it with a native id, so it can be forked. */
const spawnAndEnd = async (
  arranged: Arranged,
  fields: Record<string, unknown> = {},
): Promise<Session> => {
  const session = await spawnOk(arranged, fields);
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        providerAccountId: session.providerAccountId,
      },
    ],
  });
  await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

/** Spawns a Thread, runs its first turn to the end, and returns it once it is idle. */
const spawnIdle = async (
  arranged: Arranged,
  fields: Record<string, unknown> = {},
): Promise<Session> => {
  const session = await spawnOk(arranged, fields);
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  reportTurnStarted(arranged, session.id, 2);
  reportTurnCompleted(arranged, session.id, 3);
  return await waitForSession(arranged, session.id, (one) => one.status === "idle");
};

/**
 * Starts a Thread that may start Threads, and returns it with its session
 * token. `fields` are extra spawn fields.
 */
const startCaller = async (
  arranged: Arranged,
  fields: Partial<Omit<SessionSpawnInput, "prompt" | "permissionProfileId">> = {},
) =>
  spawnThreadUnder(
    arranged,
    await createProfile(arranged, "thread-starter", ["session.spawn", "thread.start"]),
    fields,
  );

const forkSession = async (
  arranged: Arranged,
  parentId: string,
  fields: Record<string, unknown> = {},
): Promise<Session> =>
  readOk(
    await post(
      arranged.harness.base,
      `/api/v1/sessions/${parentId}/continue`,
      { mode: "fork", prompt: "carry on", ...fields },
      arranged.token,
    ),
  );

const markDone = async (arranged: Arranged, id: string): Promise<void> => {
  await readOk(
    await post(
      arranged.harness.base,
      "/api/v1/sessions/mark-done",
      { sessionIds: [id] },
      arranged.token,
    ),
  );
};

/* ------------------------------------------------------------------------ */
/* Helpers: reading the rows the rule writes.                                */
/* ------------------------------------------------------------------------ */

/** Removes the dashes of an id, the form `lower(hex(...))` reads rows in. */
const compact = (id: string): string => id.replaceAll("-", "");

const runSql = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

/** Runs a write in a transaction: the harness's connection reads only, and a transaction takes the writer. */
const runWrite = <A>(arranged: Arranged, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  runSql(
    withTransaction(
      arranged.harness.sql,
      Effect.provideService(effect, SqlClient.SqlClient, arranged.harness.sql),
    ),
  );

/** Counts the rows of a table. */
const countRows = async (
  arranged: Arranged,
  table: "tasks" | "sessions" | "workspaces" | "task_workspaces",
): Promise<number> => {
  const [row] = await runSql(
    arranged.harness.sql<{
      readonly n: number;
    }>`SELECT COUNT(*) AS n FROM ${arranged.harness.sql(table)}`,
  );
  return row!.n;
};

/** Lists the ids of every Task row, deleted ones included, without dashes. */
const listTaskIds = async (arranged: Arranged): Promise<ReadonlyArray<string>> =>
  (
    await runSql(
      arranged.harness.sql<{ readonly id: string }>`SELECT lower(hex(id)) AS id FROM tasks`,
    )
  ).map((row) => row.id);

/** Lists `task_workspaces` as `workspaceId:taskId` strings without dashes, sorted. */
const listWorkspaceTasks = async (arranged: Arranged): Promise<ReadonlyArray<string>> =>
  (
    await runSql(
      arranged.harness.sql<{ readonly workspace_id: string; readonly task_id: string }>`
        SELECT lower(hex(workspace_id)) AS workspace_id, lower(hex(task_id)) AS task_id
        FROM task_workspaces`,
    )
  )
    .map((row) => `${row.workspace_id}:${row.task_id}`)
    .toSorted();

/** Formats a `task_workspaces` row as the `workspaceId:taskId` string that `listWorkspaceTasks` returns. */
const formatWorkspaceTask = (
  workspaceId: string | null | undefined,
  taskId: string | undefined,
): string => `${compact(String(workspaceId))}:${compact(String(taskId))}`;

/** Takes the sessions' Task away, as the upgrade left the Threads that were Done. */
const clearTask = async (arranged: Arranged, sessionId: string): Promise<void> => {
  await runWrite(
    arranged,
    arranged.harness
      .sql`UPDATE sessions SET task_id = NULL WHERE id = unhex(${compact(sessionId)})`,
  );
};

/** Sets the Task of a session through the repository, as moving a Thread to another Task will. */
const moveSessionToTask = (arranged: Arranged, sessionId: string, taskId: string): Promise<void> =>
  runWrite(
    arranged,
    Effect.flatMap(sessionRepository, (rows) => rows.setTaskId(sessionId, taskId)),
  );

/** What the Tasks and `task.created` events were before the call under test. */
interface Snapshot {
  readonly taskIds: ReadonlyArray<string>;
  readonly createdEvents: number;
}

const takeSnapshot = async (arranged: Arranged): Promise<Snapshot> => ({
  taskIds: await listTaskIds(arranged),
  createdEvents: (await arranged.harness.platformEvents("task.created")).length,
});

/** What the rule must have decided for one session. */
type Expected =
  | { readonly kind: "joins"; readonly taskId: string }
  | { readonly kind: "none" }
  | {
      readonly kind: "new";
      readonly title: string;
      readonly actor: string;
      /** The project the made Task must have; undefined when it must have none. */
      readonly projectId?: string;
    };

interface Outcome {
  readonly before: Snapshot;
  readonly session: Session;
  readonly expected: Expected;
  /** The rows `task_workspaces` must hold afterwards. When undefined, the rows are not checked. */
  readonly workspaceTasks?: ReadonlyArray<string>;
}

/**
 * Checks what the rule decided: the session's stored Task, the Tasks and
 * `task.created` events the call added, and `task_workspaces`.
 */
const expectOutcome = async (arranged: Arranged, outcome: Outcome): Promise<void> => {
  const { before, expected } = outcome;
  const stored = await readSession(arranged, outcome.session.id);
  const after = await takeSnapshot(arranged);
  const added = after.taskIds.filter((id) => !before.taskIds.includes(id));
  if (expected.kind === "joins") {
    expect(stored.taskId).toBe(expected.taskId);
    expect(added).toEqual([]);
    expect(after.createdEvents).toBe(before.createdEvents);
  } else if (expected.kind === "none") {
    expect(stored.taskId).toBeUndefined();
    expect(added).toEqual([]);
    expect(after.createdEvents).toBe(before.createdEvents);
  } else {
    expect(stored.taskId).toBeDefined();
    expect(added).toEqual([compact(stored.taskId!)]);
    const task = await readTask(arranged, stored.taskId!);
    expect(task).toMatchObject({
      title: expected.title,
      stage: "exploring",
      status: "open",
      priority: "normal",
    });
    expect(task.projectId).toBe(expected.projectId);
    const created = await arranged.harness.platformEvents("task.created");
    expect(created).toHaveLength(before.createdEvents + 1);
    const last = created.at(-1)!;
    expect((last.payload as { task: { id: string } }).task.id).toBe(stored.taskId);
    expect(last.actor).toBe(expected.actor);
  }
  if (outcome.workspaceTasks !== undefined) {
    expect(await listWorkspaceTasks(arranged)).toEqual([...outcome.workspaceTasks].toSorted());
  }
};

/* ------------------------------------------------------------------------ */
/* session.spawn and session.continue                                        */
/* ------------------------------------------------------------------------ */

interface Row {
  readonly name: string;
  /** Arranges the rows, starts one session, and says what the rule must have decided. */
  readonly run: (arranged: Arranged, repo: string) => Promise<Outcome>;
}

const JOIN_ROWS: ReadonlyArray<Row> = [
  {
    name: "row 1: a named Task wins over the workspace's Task, and leaves the workspace's row alone",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      const named = await createTask(arranged, "Named work");
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, {
        taskId: named.id,
        workspace: buildExistingWorkspace(first),
      });
      return {
        before,
        session,
        expected: { kind: "joins", taskId: named.id },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, first.taskId)],
      };
    },
  },
  {
    name: "row 2: a Thread started by a session joins the caller's Task",
    run: async (arranged) => {
      const caller = await startCaller(arranged);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, {}, caller.token);
      return {
        before,
        session,
        expected: { kind: "joins", taskId: caller.session.taskId! },
        workspaceTasks: [],
      };
    },
  },
  {
    name: "row 2: a fork takes its parent's Task",
    run: async (arranged) => {
      const parent = await spawnAndEnd(arranged);
      const before = await takeSnapshot(arranged);
      const session = await forkSession(arranged, parent.id);
      return {
        before,
        session,
        expected: { kind: "joins", taskId: parent.taskId! },
        workspaceTasks: [],
      };
    },
  },
  {
    name: "row 3: the second Thread of an ephemeral workspace joins the first one's Task, and task_workspaces holds it",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, { workspace: buildExistingWorkspace(first) });
      return {
        before,
        session,
        expected: { kind: "joins", taskId: first.taskId! },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, first.taskId)],
      };
    },
  },
  {
    name: "row 3 never applies in a main workspace: each Thread there gets its own Task and no row is written",
    run: async (arranged, repo) => {
      const workspace = { kind: "primary", resourceId: repo };
      const first = await spawnOk(arranged, { workspace });
      expect(first.taskId).toBeDefined();
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, { prompt: "a second job", workspace });
      expect(session.workspaceId).toBe(first.workspaceId);
      return {
        before,
        session,
        expected: { kind: "new", title: "a second job", actor: "user" },
        workspaceTasks: [],
      };
    },
  },
  {
    name: "row 4: a Thread with no workspace gets a new Task",
    run: async (arranged) => {
      await spawnOk(arranged, { prompt: "an earlier job" });
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, { prompt: "this job" });
      return {
        before,
        session,
        expected: { kind: "new", title: "this job", actor: "user" },
        workspaceTasks: [],
      };
    },
  },
  {
    name: "row 3 after Done: the workspace's Task is finished, so the next Thread gets a new Task and replaces the row",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      await finishTask(arranged, first.taskId!);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, {
        prompt: "back in the folder",
        workspace: buildExistingWorkspace(first),
      });
      const stored = await readSession(arranged, session.id);
      return {
        before,
        session,
        expected: { kind: "new", title: "back in the folder", actor: "user" },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, stored.taskId)],
      };
    },
  },
  {
    name: "two simultaneous first Threads in one workspace share one Task",
    run: async (arranged, repo) => {
      // The workspace has no live Task once its first one is finished.
      const first = await spawnInNewWorkspace(arranged, repo);
      await finishTask(arranged, first.taskId!);
      const before = await takeSnapshot(arranged);
      const [one, other] = await Promise.all([
        spawnOk(arranged, { prompt: "same folder", workspace: buildExistingWorkspace(first) }),
        spawnOk(arranged, { prompt: "same folder", workspace: buildExistingWorkspace(first) }),
      ]);
      const stored = await readSession(arranged, one.id);
      expect((await readSession(arranged, other.id)).taskId).toBe(stored.taskId);
      return {
        before,
        session: one,
        expected: { kind: "new", title: "same folder", actor: "user" },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, stored.taskId)],
      };
    },
  },
  {
    name: "an Agent's session with nothing to join has no Task and makes none",
    run: async (arranged) => {
      const agentId = await createAgentId(arranged);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, { agentId });
      return { before, session, expected: { kind: "none" }, workspaceTasks: [] };
    },
  },
  {
    name: "an Agent's session joins the live Task of its workspace",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      const agentId = await createAgentId(arranged);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, {
        agentId,
        workspace: buildExistingWorkspace(first),
      });
      return {
        before,
        session,
        expected: { kind: "joins", taskId: first.taskId! },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, first.taskId)],
      };
    },
  },
  {
    name: "an Agent's session in a workspace whose Task is finished has no Task and makes none",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      await finishTask(arranged, first.taskId!);
      const agentId = await createAgentId(arranged);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, {
        agentId,
        workspace: buildExistingWorkspace(first),
      });
      return { before, session, expected: { kind: "none" } };
    },
  },
  {
    name: "a Thread started in a project gets a new Task in that project",
    run: async (arranged) => {
      const { id: projectId } = await readOk<{ id: string }>(
        await post(arranged.harness.base, "/api/v1/projects", { name: "Live" }, arranged.token),
      );
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, { prompt: "in the project", projectId });
      expect(session.projectId).toBe(projectId);
      return {
        before,
        session,
        expected: { kind: "new", title: "in the project", actor: "user", projectId },
      };
    },
  },
  {
    name: "a fork of a Thread whose project was deleted gets a new Task with no project",
    run: async (arranged) => {
      const { id: projectId } = await readOk<{ id: string }>(
        await post(arranged.harness.base, "/api/v1/projects", { name: "Old" }, arranged.token),
      );
      const parent = await spawnAndEnd(arranged, { projectId });
      await finishTask(arranged, parent.taskId!);
      await readOk(
        await del(arranged.harness.base, `/api/v1/projects/${projectId}`, arranged.token),
      );
      const before = await takeSnapshot(arranged);
      const session = await forkSession(arranged, parent.id, { prompt: "after the project" });
      expect(session.projectId).toBe(projectId);
      return {
        before,
        session,
        expected: { kind: "new", title: "after the project", actor: "user" },
      };
    },
  },
  {
    name: "a caller on a finished Task falls through to the workspace's Task",
    run: async (arranged, repo) => {
      const { first, other } = await arrangeThreadOnFinishedTask(arranged, repo);
      const caller = await startCaller(arranged, {
        taskId: other.id,
        workspace: buildExistingWorkspace(first),
      });
      await finishTask(arranged, other.id);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, {}, caller.token);
      expect(session.workspaceId).toBe(first.workspaceId);
      return { before, session, expected: { kind: "joins", taskId: first.taskId! } };
    },
  },
  {
    name: "a caller on a finished Task with no workspace gets a new Task, stamped with the caller",
    run: async (arranged) => {
      const caller = await startCaller(arranged);
      await finishTask(arranged, caller.session.taskId!);
      const before = await takeSnapshot(arranged);
      const session = await spawnOk(arranged, { prompt: "a fresh job" }, caller.token);
      return {
        before,
        session,
        expected: { kind: "new", title: "a fresh job", actor: `session:${caller.session.id}` },
      };
    },
  },
  {
    name: "a fork whose parent is on a finished Task falls through to the workspace's Task",
    run: async (arranged, repo) => {
      const { first, other } = await arrangeThreadOnFinishedTask(arranged, repo);
      const parent = await spawnAndEnd(arranged, {
        taskId: other.id,
        workspace: buildExistingWorkspace(first),
      });
      await finishTask(arranged, other.id);
      const before = await takeSnapshot(arranged);
      const session = await forkSession(arranged, parent.id);
      expect(session.workspaceId).toBe(first.workspaceId);
      return { before, session, expected: { kind: "joins", taskId: first.taskId! } };
    },
  },
  {
    name: "a fork whose parent is on a finished Task with no workspace gets a new Task",
    run: async (arranged) => {
      const parent = await spawnAndEnd(arranged);
      await finishTask(arranged, parent.taskId!);
      const before = await takeSnapshot(arranged);
      const session = await forkSession(arranged, parent.id, { prompt: "a fresh fork" });
      return {
        before,
        session,
        expected: { kind: "new", title: "a fresh fork", actor: "user" },
      };
    },
  },
];

/** Creates an Agent that can run on the fleet's account, and returns its id. */
const createAgentId = async (arranged: Arranged): Promise<string> => {
  const profiles = await readOk<{ items: ReadonlyArray<{ id: string; name: string }> }>(
    await get(arranged.harness.base, "/api/v1/profiles", arranged.token),
  );
  const agent = await readOk<{ id: string }>(
    await post(
      arranged.harness.base,
      "/api/v1/agents",
      {
        name: `agent-${crypto.randomUUID()}`,
        systemPrompt: "You assess tasks.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/test"),
        permissionProfileId: profiles.items.find((one) => one.name === "worker")!.id,
      },
      arranged.token,
    ),
  );
  return agent.id;
};

/**
 * Starts a Thread in a new ephemeral workspace (its Task is the workspace's
 * live Task), and files a second Task for a session to be named into the same
 * workspace without changing the workspace's row.
 */
const arrangeThreadOnFinishedTask = async (
  arranged: Arranged,
  repo: string,
): Promise<{ readonly first: Session; readonly other: Task }> => ({
  first: await spawnInNewWorkspace(arranged, repo),
  other: await createTask(arranged, "The Task that will be finished"),
});

describe("the join rule on session.spawn and session.continue", () => {
  it.each(JOIN_ROWS)("$name", async (row) => {
    await withFleet(async (arranged) => {
      const repo = await createRepo(arranged, "https://github.com/acme/web");
      await expectOutcome(arranged, await row.run(arranged, repo));
    });
  });

  it.each([
    ["done", "invalid_state", 409],
    ["dropped", "invalid_state", 409],
    ["missing", "not_found", 404],
    ["deleted", "not_found", 404],
  ] as const)(
    "refuses a named Task that is %s, and writes nothing",
    async (state, code, status) => {
      await withFleet(async (arranged) => {
        const repo = await createRepo(arranged, "https://github.com/acme/web");
        let taskId = "0199f0b7-0000-7000-8000-00000000dead";
        if (state !== "missing") {
          taskId = (await createTask(arranged, "A closed job")).id;
          if (state === "deleted") {
            await readOk(
              await del(arranged.harness.base, `/api/v1/tasks/${taskId}`, arranged.token),
            );
          } else {
            await updateTask(arranged, taskId, { stage: state });
          }
        }
        const tables = ["tasks", "sessions", "workspaces", "task_workspaces"] as const;
        const before = await Promise.all(tables.map((table) => countRows(arranged, table)));
        const createdBefore = (await arranged.harness.platformEvents("task.created")).length;

        const response = await post(
          arranged.harness.base,
          "/api/v1/sessions",
          {
            prompt: "work on it",
            taskId,
            workspace: { kind: "ephemeral", checkouts: [{ resourceId: repo }] },
          },
          arranged.token,
        );

        expect(response.status, await response.clone().text()).toBe(status);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe(code);
        if (state === "done" || state === "dropped") {
          expect(body.error.message).toMatch(/reopen/i);
        }
        expect(await Promise.all(tables.map((table) => countRows(arranged, table)))).toEqual(
          before,
        );
        expect((await arranged.harness.platformEvents("task.created")).length).toBe(createdBefore);
      });
    },
  );

  it("makes one Task for a spawn retried with one dedup key", async () => {
    await withFleet(async (arranged) => {
      const before = await takeSnapshot(arranged);

      const first = await spawnOk(arranged, { prompt: "once", dedupKey: "build-1" });
      const repeat = await spawnOk(arranged, { prompt: "once", dedupKey: "build-1" });

      expect(repeat.id).toBe(first.id);
      const after = await takeSnapshot(arranged);
      expect(after.taskIds).toHaveLength(before.taskIds.length + 1);
      expect(after.createdEvents).toBe(before.createdEvents + 1);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Reopen against resume                                                     */
/* ------------------------------------------------------------------------ */

/** Takes a Done Thread off Done the explicit way, with `session.reopen`. */
const reopenThread = async (arranged: Arranged, id: string): Promise<void> => {
  await readOk(
    await post(
      arranged.harness.base,
      "/api/v1/sessions/reopen",
      { sessionIds: [id] },
      arranged.token,
    ),
  );
};

/** Takes a Done Thread off Done by sending it an input. */
const sendInput = async (arranged: Arranged, id: string): Promise<void> => {
  await readOk(
    await post(
      arranged.harness.base,
      `/api/v1/sessions/${id}/input`,
      { text: "one more thing" },
      arranged.token,
    ),
  );
};

interface ReopenRow {
  readonly name: string;
  /** Arranges a Done Thread, and says what the rule must decide when it comes back. */
  readonly run: (
    arranged: Arranged,
    repo: string,
  ) => Promise<{
    readonly thread: Session;
    readonly expected: Expected;
    readonly workspaceTasks?: ReadonlyArray<string>;
  }>;
}

const REOPEN_ROWS: ReadonlyArray<ReopenRow> = [
  {
    name: "a Done Thread with no Task and no workspace gets a new Task",
    run: async (arranged) => {
      const thread = await spawnIdle(arranged, { prompt: "left over" });
      await clearTask(arranged, thread.id);
      await markDone(arranged, thread.id);
      return { thread, expected: { kind: "new", title: "left over", actor: "user" } };
    },
  },
  {
    name: "a Done Thread on a finished Task gets a new Task",
    run: async (arranged) => {
      const thread = await spawnIdle(arranged, { prompt: "closed earlier" });
      await finishTask(arranged, thread.taskId!);
      await markDone(arranged, thread.id);
      return { thread, expected: { kind: "new", title: "closed earlier", actor: "user" } };
    },
  },
  {
    name: "a Done Thread on a finished Task joins the live Task of its workspace",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      const other = await createTask(arranged, "The Task that will be finished");
      const thread = await spawnIdle(arranged, {
        taskId: other.id,
        workspace: buildExistingWorkspace(first),
      });
      await finishTask(arranged, other.id);
      await markDone(arranged, thread.id);
      return {
        thread,
        expected: { kind: "joins", taskId: first.taskId! },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, first.taskId)],
      };
    },
  },
  {
    name: "a Done Thread on a Task that is not finished keeps its Task",
    run: async (arranged) => {
      const thread = await spawnIdle(arranged);
      await markDone(arranged, thread.id);
      return { thread, expected: { kind: "joins", taskId: thread.taskId! } };
    },
  },
  {
    name: "a Done Thread that keeps its Task leaves the workspace's row alone, even when that row names a finished Task",
    run: async (arranged, repo) => {
      const first = await spawnInNewWorkspace(arranged, repo);
      const named = await createTask(arranged, "Named work");
      // Naming a Task leaves the workspace's row on the first Thread's Task.
      const thread = await spawnIdle(arranged, {
        taskId: named.id,
        workspace: buildExistingWorkspace(first),
      });
      await finishTask(arranged, first.taskId!);
      await markDone(arranged, thread.id);
      return {
        thread,
        expected: { kind: "joins", taskId: named.id },
        workspaceTasks: [formatWorkspaceTask(first.workspaceId, first.taskId)],
      };
    },
  },
];

/** Arranges the row, takes its Thread off Done with `fire`, and checks what the rule decided. */
const expectReopenOutcome = async (
  row: ReopenRow,
  fire: (arranged: Arranged, id: string) => Promise<void>,
): Promise<void> => {
  await withFleet(async (arranged) => {
    const repo = await createRepo(arranged, "https://github.com/acme/web");
    const { thread, expected, workspaceTasks } = await row.run(arranged, repo);
    const before = await takeSnapshot(arranged);

    await fire(arranged, thread.id);

    const reopened = await readSession(arranged, thread.id);
    expect("done" in reopened).toBe(false);
    await expectOutcome(arranged, {
      before,
      session: thread,
      expected,
      ...(workspaceTasks === undefined ? {} : { workspaceTasks }),
    });
  });
};

describe("a Done Thread taken off Done by session.reopen", () => {
  it.each(REOPEN_ROWS)("$name", (row) => expectReopenOutcome(row, reopenThread));
});

describe("a Done Thread taken off Done by a new input", () => {
  // Both ways take the Thread off Done through the same function; one row (the
  // second one, a finished Task) shows that a new input reaches it.
  it("on a finished Task gets a new Task", () => expectReopenOutcome(REOPEN_ROWS[1]!, sendInput));
});

describe("reopening against resuming", () => {
  it("keeps the Task of a Thread that was never Done and is resumed, even when the Task is finished", async () => {
    await withFleet(async (arranged) => {
      const thread = await spawnAndEnd(arranged);
      await finishTask(arranged, thread.taskId!);
      const before = await takeSnapshot(arranged);

      await readOk(
        await post(
          arranged.harness.base,
          `/api/v1/sessions/${thread.id}/input`,
          { text: "pick this up again" },
          arranged.token,
        ),
      );
      // The resume sends a second start frame for the same session.
      await waitForStartFrames(arranged, thread.id, 2);

      const resumed = await readSession(arranged, thread.id);
      expect(resumed.taskId).toBe(thread.taskId);
      expect("reopenedAt" in resumed).toBe(false);
      expect(await arranged.harness.audit("session.reopened")).toHaveLength(0);
      expect(await takeSnapshot(arranged)).toEqual(before);
    });
  });

  it("titles the Task of a Done Thread with a blank title 'Untitled thread', and the Task still reads", async () => {
    await withFleet(async (arranged) => {
      const thread = await spawnIdle(arranged, { prompt: "to be blanked" });
      await clearTask(arranged, thread.id);
      await runWrite(
        arranged,
        arranged.harness
          .sql`UPDATE sessions SET title = '' WHERE id = unhex(${compact(thread.id)})`,
      );
      await markDone(arranged, thread.id);

      await reopenThread(arranged, thread.id);

      const taskId = (await readSession(arranged, thread.id)).taskId;
      expect(taskId).toBeDefined();
      expect((await readTask(arranged, taskId!)).title).toBe("Untitled thread");
      const listed = await readOk<{ items: ReadonlyArray<Task> }>(
        await get(arranged.harness.base, "/api/v1/tasks", arranged.token),
      );
      expect(listed.items.map((task) => task.id)).toContain(taskId);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* The Task follows the Thread's generated title                             */
/* ------------------------------------------------------------------------ */

const GENERATED_TITLE = "Fix the login redirect";

const buildTitleAnswer = (title: string): TextGenerationOutcome => ({
  outcome: "ok",
  value: { title, needsRefinement: false, role: "fix" },
  usage: null,
});

/** The ways a Task is read after the Thread's title was answered. */
interface Titles {
  /** Sends the model's answer to the request that was made for the Thread whose prompt is `prompt`. */
  readonly answer: (prompt: string, title: string) => Promise<void>;
  /**
   * Answers a later Thread's request, and waits until that Thread's Task has
   * its title. The runner answers one request at a time, so by then an earlier
   * answer has been handled, whatever it did.
   */
  readonly waitForLaterAnswer: () => Promise<void>;
}

/**
 * Runs `body` against a fleet whose runner leaves every title request
 * unanswered until the test answers it, so the test can change the Thread or
 * its Task first.
 */
const withHeldTitles = (
  body: (arranged: Arranged, titles: Titles) => Promise<void>,
): Promise<void> =>
  withFleet(async (arranged) => {
    const requests: Array<TextGenerationRequest> = [];
    arranged.wire.setTextGenerationAnswer((request) => {
      requests.push(request);
      return undefined;
    });
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
    const answer = async (prompt: string, title: string): Promise<void> => {
      const request = await waitUntil("asked for the title of the Thread", () =>
        requests.find((one) => one.spec.input === prompt),
      );
      arranged.wire.send({
        _tag: "textGenerationReport",
        requestId: request.requestId,
        outcome: buildTitleAnswer(title),
      });
    };
    const waitForLaterAnswer = async (): Promise<void> => {
      const later = await spawnOk(arranged, { prompt: "a later thread" });
      await answer("a later thread", "Later title");
      await waitUntil("renamed the Task of the later Thread", async () => {
        const stored = await readSession(arranged, later.id);
        return (await readTask(arranged, stored.taskId!)).title === "Later title"
          ? true
          : undefined;
      });
    };
    await body(arranged, { answer, waitForLaterAnswer });
  });

interface TitleRow {
  readonly name: string;
  /**
   * Starts the Thread "login redirect is broken", changes what the title must
   * leave alone, answers the request, and returns the title each watched Task
   * must have afterwards.
   */
  readonly run: (
    arranged: Arranged,
    titles: Titles,
  ) => Promise<ReadonlyArray<readonly [string, string]>>;
}

const CUT_SHORT = "login redirect is broken";

const TITLE_ROWS: ReadonlyArray<TitleRow> = [
  {
    name: "a Task made for the Thread, which takes the generated title, renamed as the system",
    run: async (arranged, titles) => {
      const thread = await spawnOk(arranged, { prompt: CUT_SHORT });
      await titles.answer(CUT_SHORT, GENERATED_TITLE);
      await waitUntil("renamed the Task", async () =>
        (await readTask(arranged, thread.taskId!)).title === GENERATED_TITLE ? true : undefined,
      );
      const updates = await arranged.harness.platformEvents("task.updated");
      expect(updates.map((event) => event.actor)).toEqual(["system"]);
      return [[thread.taskId!, GENERATED_TITLE]];
    },
  },
  {
    name: "a Task the Thread joined is left alone",
    run: async (arranged, titles) => {
      const existing = await createTask(arranged, "Existing work");
      await spawnOk(arranged, { prompt: CUT_SHORT, taskId: existing.id });
      await titles.answer(CUT_SHORT, GENERATED_TITLE);
      return [[existing.id, "Existing work"]];
    },
  },
  {
    name: "a renamed Task is left alone",
    run: async (arranged, titles) => {
      const thread = await spawnOk(arranged, { prompt: CUT_SHORT });
      await updateTask(arranged, thread.taskId!, { title: "Renamed by the user" });
      await titles.answer(CUT_SHORT, GENERATED_TITLE);
      return [[thread.taskId!, "Renamed by the user"]];
    },
  },
  {
    name: "a finished Task is left alone",
    run: async (arranged, titles) => {
      const thread = await spawnOk(arranged, { prompt: CUT_SHORT });
      await finishTask(arranged, thread.taskId!);
      await titles.answer(CUT_SHORT, GENERATED_TITLE);
      return [[thread.taskId!, CUT_SHORT]];
    },
  },
  {
    name: "a Task the Thread has left is left alone, and so is the Task it moved to",
    run: async (arranged, titles) => {
      const thread = await spawnOk(arranged, { prompt: CUT_SHORT });
      const other = await createTask(arranged, "Other work");
      await moveSessionToTask(arranged, thread.id, other.id);
      await titles.answer(CUT_SHORT, GENERATED_TITLE);
      return [
        [thread.taskId!, CUT_SHORT],
        [other.id, "Other work"],
      ];
    },
  },
  {
    name: "a late answer after the Thread moved to a new Task with the same title leaves both Tasks alone",
    run: async (arranged, titles) => {
      const thread = await spawnOk(arranged, { prompt: CUT_SHORT });
      const same = await createTask(arranged, CUT_SHORT);
      await moveSessionToTask(arranged, thread.id, same.id);
      await titles.answer(CUT_SHORT, GENERATED_TITLE);
      return [
        [thread.taskId!, CUT_SHORT],
        [same.id, CUT_SHORT],
      ];
    },
  },
];

describe("the Task follows the Thread's generated title", () => {
  it.each(TITLE_ROWS)("$name", async (row) => {
    await withHeldTitles(async (arranged, titles) => {
      const watched = await row.run(arranged, titles);

      await titles.waitForLaterAnswer();

      for (const [taskId, title] of watched) {
        expect((await readTask(arranged, taskId)).title, taskId).toBe(title);
      }
    });
  });
});

/* ------------------------------------------------------------------------ */
/* A Thread started on a Task by name ends that Task's failure.              */
/* ------------------------------------------------------------------------ */

/** The run a Task shows as failed in the rows below. It never has to exist. */
const FAILED_RUN_ID = "0199f0b7-0000-7000-8000-00000000fa11";

/** Makes the Task show the failure of `FAILED_RUN_ID`, and returns its failure revision. */
const showFailure = async (arranged: Arranged, taskId: string): Promise<number> => {
  await runWrite(
    arranged,
    arranged.harness.sql`UPDATE tasks
      SET failed_run_id = unhex(${compact(FAILED_RUN_ID)}), failure_revision = failure_revision + 1
      WHERE id = unhex(${compact(taskId)})`,
  );
  return (await readFailure(arranged, taskId)).failureRevision;
};

/** Reads the failure the Task shows and its failure revision. */
const readFailure = async (arranged: Arranged, taskId: string) => {
  const [row] = await runSql(
    arranged.harness.sql<{
      readonly failed_run_id: string | null;
      readonly failure_revision: number;
    }>`SELECT NULLIF(lower(hex(failed_run_id)), '') AS failed_run_id, failure_revision
       FROM tasks WHERE id = unhex(${compact(taskId)})`,
  );
  return { failedRunId: row!.failed_run_id, failureRevision: row!.failure_revision };
};

describe("the failure a Task shows, when a Thread joins it", () => {
  it("ends when a Thread is started on the Task by name, and the revision rises so an older Undo cannot restore it", async () => {
    await withFleet(async (arranged) => {
      const task = await createTask(arranged, "Refund button");
      const revision = await showFailure(arranged, task.id);

      const session = await spawnOk(arranged, { taskId: task.id });

      expect(session.taskId).toBe(task.id);
      expect(await readFailure(arranged, task.id)).toEqual({
        failedRunId: null,
        failureRevision: revision + 1,
      });
    });
  });

  it.each([
    [
      "the workspace's Task",
      async (arranged: Arranged, repo: string) => {
        const first = await spawnInNewWorkspace(arranged, repo);
        return {
          taskId: first.taskId!,
          join: () => spawnOk(arranged, { workspace: buildExistingWorkspace(first) }),
        };
      },
    ],
    [
      "the Task of the session that starts it",
      async (arranged: Arranged) => {
        const caller = await startCaller(arranged);
        return {
          taskId: caller.session.taskId!,
          join: () => spawnOk(arranged, {}, caller.token),
        };
      },
    ],
  ])("is kept when a Thread joins %s", async (_name, arrange) => {
    await withFleet(async (arranged) => {
      const repo = await createRepo(arranged, "https://github.com/acme/web");
      const { taskId, join } = await arrange(arranged, repo);
      const revision = await showFailure(arranged, taskId);

      const session = await join();

      expect(session.taskId).toBe(taskId);
      expect(await readFailure(arranged, taskId)).toEqual({
        failedRunId: FAILED_RUN_ID.replaceAll("-", ""),
        failureRevision: revision,
      });
    });
  });
});
