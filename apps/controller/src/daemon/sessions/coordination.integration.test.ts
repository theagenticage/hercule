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
 * - only the first five repositories get a line with Wiki facts.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../../db";
import { permissionRequestRepository } from "../../permissions";
import { WAIT_DEADLINE_MS, createProfile, type Arranged } from "../../sessions/testing";
import { createRepo, spawnWithCheckouts, withFleet } from "../../workspaces/testing";
import { buildSessionCoordination } from "./coordination";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Runs an effect that needs the database against the controller's database. */
const runWithDatabase = <A>(
  arranged: Arranged,
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.orDie(Effect.provideService(effect, SqlClient.SqlClient, arranged.harness.sql)),
  );

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
      expect(frame.spec.coordination).toBeUndefined();

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
      expect(
        await runWithDatabase(arranged, buildSessionCoordination(frame.sessionId)),
      ).toBeUndefined();

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
});
