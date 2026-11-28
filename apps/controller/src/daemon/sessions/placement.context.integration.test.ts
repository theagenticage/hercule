/**
 * Tests `session.spawn` with `context` (spec 11, "session.spawn takes
 * `context?`"): the controller appends a block that describes the things after
 * the user's words, and that text is the session's first input.
 *
 * The tests use the real API, the real runner socket and real rows. The
 * things are rows of the invented northwind plugin, each read by one account.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { MAX_PROMPT_LENGTH, type Session } from "@hercule/contract";
import {
  arrangeThing,
  buildNorthwind,
  CHANGE_KIND,
  createAccount,
  TICKET_KIND,
  type Thing,
} from "../../external-entities/testing";
import { withTransaction } from "../../db";
import { post } from "../../http/testing";
import {
  createProfile,
  listInputs,
  spawnThreadUnder,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import { withFleet } from "../../workspaces/testing";

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

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Makes the things concern the user, so they are on the Inbox and can form a group. */
const putOnInbox = async (arranged: Arranged, things: ReadonlyArray<Thing>) => {
  for (const thing of things) {
    await runWrite(
      arranged,
      arranged.harness
        .sql`UPDATE external_entity_observations SET concerns = '["assigned"]' WHERE ref = ${thing.ref}`,
    );
  }
};

const link = async (arranged: Arranged, from: Thing, to: Thing) => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/external-entities/links",
    { fromRef: from.ref, toRefs: [to.ref] },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Returns the text of the session's first input. */
const readFirstInput = async (arranged: Arranged, session: Session): Promise<string> =>
  (await listInputs(arranged, session.id))[0]!.text;

const ids = (...things: ReadonlyArray<Thing>) =>
  things.map((thing) => ({ kind: "entity", entityId: thing.id }));

describe("session.spawn with context", () => {
  it("stores exactly the block as the input when the words are empty", async () => {
    await withThings(async (arranged, account) => {
      const first = await arrange(arranged, account, "WEB-1");
      const second = await arrange(arranged, account, "WEB-2");

      const session = await spawnOk(arranged, { prompt: "", context: ids(first, second) });

      const lines = (await readFirstInput(arranged, session)).split("\n");
      expect(lines).toEqual([
        "From your selection (2 things)",
        expect.stringMatching(new RegExp(`^1\\. ${first.ref} · “Thing WEB-1” · ${UUID}$`)),
        expect.stringMatching(new RegExp(`^2\\. ${second.ref} · “Thing WEB-2” · ${UUID}$`)),
        "Read any of them in full: hercule entity read <id>",
      ]);
    });
  });

  it("puts the block after the user's words and a blank line, and titles the Thread from the words", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");

      const session = await spawnOk(arranged, { prompt: "Fix the cart", context: ids(thing) });

      const text = await readFirstInput(arranged, session);
      expect(text).toMatch(
        new RegExp(
          `^Fix the cart\\n\\nFrom your Inbox \\(1 thing\\)\\n1\\. ${thing.ref} · “Thing WEB-1” · ${UUID}\\nRead any`,
        ),
      );
      expect(session.title).toBe("Fix the cart");
    });
  });

  it("titles a Thread that has only context from the first thing's title", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");

      const session = await spawnOk(arranged, { prompt: "", context: ids(thing) });

      expect(session.title).toBe("Thing WEB-1");
    });
  });

  it("names the group when the things are exactly one linked group, and a selection for part of it", async () => {
    await withThings(async (arranged, account) => {
      const things = [
        await arrange(arranged, account, "WEB-1"),
        await arrange(arranged, account, "WEB-2"),
        await arrange(arranged, account, "WEB-3"),
      ];
      await putOnInbox(arranged, things);
      await link(arranged, things[0]!, things[1]!);
      await link(arranged, things[1]!, things[2]!);

      const group = await spawnOk(arranged, { context: ids(...things) });
      const part = await spawnOk(arranged, { context: ids(things[0]!, things[1]!) });

      expect(await readFirstInput(arranged, group)).toMatch(
        /^work on it\n\nFrom your linked group “Thing WEB-\d” \(3 things\)\n/,
      );
      expect(await readFirstInput(arranged, part)).toMatch(
        /^work on it\n\nFrom your selection \(2 things\)\n/,
      );
    });
  });

  it("keeps the group when newTask takes on the same things, and the Task holds them", async () => {
    await withThings(async (arranged, account) => {
      const things = [
        await arrange(arranged, account, "WEB-1"),
        await arrange(arranged, account, "WEB-2"),
      ];
      await putOnInbox(arranged, things);
      await link(arranged, things[0]!, things[1]!);

      const session = await spawnOk(arranged, {
        context: ids(...things),
        newTask: { title: "Both", entityIds: things.map((thing) => thing.id) },
      });

      expect(await readFirstInput(arranged, session)).toMatch(
        /\n\nFrom your linked group “Thing WEB-\d” \(2 things\)\n/,
      );
      expect(await listLinks(arranged, session.taskId!)).toHaveLength(2);
    });
  });

  it("treats context and newTask as independent lists", async () => {
    await withThings(async (arranged, account) => {
      const made = await arrange(arranged, account, "WEB-1");
      const told = await arrange(arranged, account, "WEB-2");

      const session = await spawnOk(arranged, {
        context: ids(told),
        newTask: { title: "Only the first", entityIds: [made.id] },
      });

      const text = await readFirstInput(arranged, session);
      expect(text).toContain(told.ref);
      expect(text).not.toContain(made.ref);
      expect(await listLinks(arranged, session.taskId!)).toEqual([
        { ref: made.ref, taken: true, by: "user" },
      ]);
    });
  });

  it("keeps the title and the facts of things that lost access, in the entries and as the group label", async () => {
    await withThings(async (arranged, account) => {
      const things = [
        await arrange(arranged, account, "WEB-1"),
        await arrange(arranged, account, "WEB-2"),
      ];
      await putOnInbox(arranged, things);
      await link(arranged, things[0]!, things[1]!);
      await runWrite(
        arranged,
        arranged.harness.sql`UPDATE external_entity_observations SET access = 'inaccessible'`,
      );

      const session = await spawnOk(arranged, { context: ids(...things) });

      const text = await readFirstInput(arranged, session);
      expect(text).toContain("\n\nFrom your linked group “Thing WEB-1” (2 things)\n");
      expect(text).toContain(`1. ${things[0]!.ref} · “Thing WEB-1” · `);
    });
  });

  it("refuses an unknown thing with not_found, and writes nothing", async () => {
    await withThings(async (arranged, account) => {
      const thing = await arrange(arranged, account, "WEB-1");
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, {
          context: [
            ...ids(thing),
            { kind: "entity", entityId: "0199f0b7-0000-7000-8000-00000000dead" },
          ],
        }),
      );

      expect(failure).toMatchObject({ status: 404, code: "not_found" });
      expect(failure.message).toContain("0199f0b7-0000-7000-8000-00000000dead");
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it("refuses a prompt that would pass the limit as a validation error at context, and leaves no Task behind", async () => {
    await withThings(async (arranged, account) => {
      const made = await arrange(arranged, account, "WEB-1");
      const told = await arrange(arranged, account, "WEB-2");
      const before = await countRows(arranged);

      const failure = await readError(
        await spawn(arranged, {
          prompt: "x".repeat(MAX_PROMPT_LENGTH),
          context: ids(told),
          newTask: { title: "Never made", entityIds: [made.id] },
        }),
      );

      expect(failure).toMatchObject({ status: 400, code: "validation" });
      expect(failure.issues).toMatchObject([
        { path: ["context"], message: expect.stringContaining("fewer things") as unknown },
      ]);
      expect(await countRows(arranged)).toEqual(before);
    });
  });

  it.each([
    ["task.read", ["session.spawn", "thread.start", "signal.read"]],
    ["signal.read", ["session.spawn", "thread.start", "task.read"]],
  ] as const)(
    "refuses a session that lacks %s, naming it, and writes nothing",
    async (missing, grants) => {
      await withThings(async (arranged, account) => {
        const thing = await arrange(arranged, account, "WEB-1");
        const caller = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, `lacks-${missing}`, grants),
        );
        const before = await countRows(arranged);

        const failure = await readError(
          await spawn(arranged, { context: ids(thing) }, caller.token),
        );

        expect(failure).toMatchObject({ status: 403, code: "forbidden" });
        expect(failure.message).toContain(missing);
        expect(await countRows(arranged)).toEqual(before);
      });
    },
  );
});
