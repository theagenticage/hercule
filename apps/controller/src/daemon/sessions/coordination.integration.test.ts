/**
 * Tests the coordination paragraph against a real controller and its database:
 * the paragraph a session's start frame carries, and the one
 * `buildSessionCoordination` builds again later, from the session's grants,
 * its checkouts and the Wikis of its repositories.
 *
 * - a session holding `wiki.read` gets a line per repository naming the
 *   Wiki's page count and its most recently changed titles;
 * - a session without `wiki.read` gets no paragraph, until a Permission
 *   Request for it is decided with outcome `session`;
 * - only the first five repositories get a line with Wiki facts;
 * - the thread that leads an open Task gets the lead paragraph, with or
 *   without a checkout, and no other session does.
 */
import { describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { LiveSessionsServices } from "../../http/testing";
import { uuidFromString, withTransaction } from "../../db";
import { permissionRequestRepository } from "../../permissions";
import {
  WAIT_DEADLINE_MS,
  createProfile,
  spawnSessionOrFail,
  type Arranged,
} from "../../sessions/testing";
import { createRepo, spawnWithCheckouts, withFleet } from "../../workspaces/testing";
import { buildLeadInstructions, buildSessionCoordination } from "./coordination";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Runs an effect that needs the database against the controller's database. */
const runWithDatabase = async <A>(
  arranged: Arranged,
  effect: Effect.Effect<A, unknown, LiveSessionsServices>,
): Promise<A> => {
  const exit = await arranged.harness.runWithLiveSessions(effect);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};

/**
 * Stores `count` pages in a repository's Wiki, titled `Page 1` and on, where
 * `Page 1` changed first and each next page one day later. The pages are
 * stored directly: the paragraph reads only the pages' titles and times.
 */
const seedPages = (arranged: Arranged, resourceId: string, count: number) =>
  runWithDatabase(
    arranged,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      withTransaction(
        sql,
        sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
          INSERT INTO wiki_pages (id, resource_id, repository, slug, title, summary, revision,
                                  updated_at, updated_by, created_at)
          SELECT randomblob(16), r.id, r.canonical_remote, 'page-' || i, 'Page ' || i, 'Seeded', 1,
                 '2026-10-' || printf('%02d', i) || 'T10:00:00.000Z', 'user',
                 '2026-10-01T10:00:00.000Z'
          FROM n, resources r WHERE r.id = unhex(${resourceId.replaceAll("-", "")})`,
      ),
    ),
  );

/**
 * The text of a thread that leads its Task and gets nothing else: a Thread
 * spawned here leads its own Task, titled by its prompt, `hello`.
 */
const LEAD_ONLY = buildLeadInstructions("hello");

/** Returns the paragraph's last block: its lines about the checked-out repositories. */
const readRepositoryLines = (paragraph: string | undefined): ReadonlyArray<string> | undefined =>
  paragraph?.split("\n\n").at(-1)?.split("\n");

describe("the coordination paragraph", () => {
  it("names a repository's page count and its five most recently changed titles, newest first", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      await seedPages(arranged, web, 7);
      const reader = await createProfile(arranged, "wiki-reader", ["wiki.read"]);

      const frame = await spawnWithCheckouts(arranged, reader.id, [web]);

      expect(readRepositoryLines(frame.spec.coordination)).toEqual([
        `github.com/acme/web (--resource ${web}). Wiki: 7 pages; recently changed, as written by agents: ` +
          `"Page 7"; "Page 6"; "Page 5"; "Page 4"; "Page 3".`,
      ]);
    });
  });

  it("is left out without wiki.read, and written once a request for it is decided for the session", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web.git");
      await seedPages(arranged, web, 1);
      const writer = await createProfile(arranged, "wiki-writer", ["wiki.write"]);

      const frame = await spawnWithCheckouts(arranged, writer.id, [web]);
      expect(frame.spec.coordination).toBe(LEAD_ONLY);

      const requests = await runWithDatabase(arranged, permissionRequestRepository);
      const requestId = await runWithDatabase(
        arranged,
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withTransaction(
            sql,
            requests.insert({
              sessionId: frame.sessionId,
              profileId: writer.id,
              grant: "wiki.read",
              reason: "To read the wiki.",
              operation: undefined,
              at: "2026-10-14T10:00:00.000Z",
            }),
          ),
        ),
      );
      // An open request grants nothing yet.
      expect(await runWithDatabase(arranged, buildSessionCoordination(frame.sessionId))).toBe(
        LEAD_ONLY,
      );

      await runWithDatabase(
        arranged,
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withTransaction(sql, requests.decide(requestId, "session", "2026-10-14T10:01:00.000Z")),
        ),
      );
      const paragraph = await runWithDatabase(arranged, buildSessionCoordination(frame.sessionId));
      expect(readRepositoryLines(paragraph)).toEqual([
        `github.com/acme/web (--resource ${web}). Wiki: 1 page; recently changed, as written by agents: "Page 1".`,
      ]);
    });
  });

  it("describes the Wikis of the first five repositories only, and lists the rest on one line", async () => {
    await withFleet(async (arranged) => {
      const names = ["one", "two", "three", "four", "five", "six"];
      const ids: Array<string> = [];
      for (const name of names)
        ids.push(await createRepo(arranged, `https://github.com/acme/${name}.git`));
      // The sixth repository has a page, which its line still leaves out.
      await seedPages(arranged, ids[5]!, 1);
      const reader = await createProfile(arranged, "wiki-reader", ["wiki.read"]);

      const frame = await spawnWithCheckouts(arranged, reader.id, ids);

      expect(readRepositoryLines(frame.spec.coordination)).toEqual([
        ...names
          .slice(0, 5)
          .map(
            (name, index) =>
              `github.com/acme/${name} (--resource ${ids[index]!}). Wiki: no pages yet.`,
          ),
        `Also checked out: github.com/acme/six (--resource ${ids[5]!}).`,
      ]);
    });
  });

  describe("the lead paragraph", () => {
    /** Runs `statement` against the database, inside a transaction. */
    const execute = (
      arranged: Arranged,
      statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown, never>,
    ) =>
      runWithDatabase(
        arranged,
        Effect.flatMap(SqlClient.SqlClient, (sql) => withTransaction(sql, statement(sql))),
      );

    /** Makes `sessionId` the lead of its own Task, titled `title`, in `stage`. */
    const makeLead = (arranged: Arranged, sessionId: string, title: string, stage = "building") =>
      execute(
        arranged,
        (sql) => sql`
          UPDATE tasks SET lead_session_id = ${uuidFromString(sessionId)}, title = ${title},
                           stage = ${stage}
          WHERE id = (SELECT task_id FROM sessions WHERE id = ${uuidFromString(sessionId)})`,
      );

    const spawnPlain = async (arranged: Arranged, resourceIds: ReadonlyArray<string> = []) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: {
          kind: "ephemeral",
          checkouts: resourceIds.map((resourceId) => ({ resourceId })),
        },
      });
      return session.id;
    };

    it("reaches a lead with no repository checked out, and is the whole text", async () => {
      await withFleet(async (arranged) => {
        const sessionId = await spawnPlain(arranged);
        await makeLead(arranged, sessionId, "Fix the login");

        expect(await runWithDatabase(arranged, buildSessionCoordination(sessionId))).toBe(
          buildLeadInstructions("Fix the login"),
        );
      });
    });

    it("reaches a lead with a repository checked out, as the first paragraph", async () => {
      await withFleet(async (arranged) => {
        const web = await createRepo(arranged, "https://github.com/acme/web.git");
        const sessionId = await spawnPlain(arranged, [web]);
        await makeLead(arranged, sessionId, "Fix the login");

        const text = await runWithDatabase(arranged, buildSessionCoordination(sessionId));

        expect(text?.startsWith(buildLeadInstructions("Fix the login"))).toBe(true);
      });
    });

    it("is left out for a helper on a Task another thread leads, and for a session on no Task", async () => {
      await withFleet(async (arranged) => {
        const leadId = await spawnPlain(arranged);
        const helperId = await spawnPlain(arranged);
        const strayId = await spawnPlain(arranged);
        await makeLead(arranged, leadId, "Fix the login");
        await execute(
          arranged,
          (sql) => sql`
            UPDATE sessions
            SET task_id = (SELECT task_id FROM sessions WHERE id = ${uuidFromString(leadId)})
            WHERE id = ${uuidFromString(helperId)}`,
        );
        await execute(
          arranged,
          (sql) => sql`UPDATE sessions SET task_id = NULL WHERE id = ${uuidFromString(strayId)}`,
        );

        expect(await runWithDatabase(arranged, buildSessionCoordination(helperId))).toBeUndefined();
        expect(await runWithDatabase(arranged, buildSessionCoordination(strayId))).toBeUndefined();
      });
    });

    it("is left out when the Task is deleted", async () => {
      await withFleet(async (arranged) => {
        const sessionId = await spawnPlain(arranged);
        await makeLead(arranged, sessionId, "Fix the login");
        await execute(
          arranged,
          (sql) => sql`
            UPDATE tasks SET deleted_at = '2026-10-14T10:00:00.000Z'
            WHERE lead_session_id = ${uuidFromString(sessionId)}`,
        );

        expect(
          await runWithDatabase(arranged, buildSessionCoordination(sessionId)),
        ).toBeUndefined();
      });
    });

    it("is left out once the Task is done or dropped", async () => {
      await withFleet(async (arranged) => {
        const sessionId = await spawnPlain(arranged);
        await makeLead(arranged, sessionId, "Fix the login", "done");
        expect(
          await runWithDatabase(arranged, buildSessionCoordination(sessionId)),
        ).toBeUndefined();

        await makeLead(arranged, sessionId, "Fix the login", "dropped");
        expect(
          await runWithDatabase(arranged, buildSessionCoordination(sessionId)),
        ).toBeUndefined();
      });
    });
  });
});
