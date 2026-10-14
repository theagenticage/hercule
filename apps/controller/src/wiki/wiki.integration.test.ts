/**
 * Tests the Wiki over HTTP, against a real controller and one fake runner on
 * the socket:
 *
 * - an update from a stale read is refused, and every write is a revision
 *   that stays readable;
 * - `read` lists only the 50 newest revisions;
 * - a create without a Resource takes the one repository the session has
 *   checked out, and is refused when there is none, several, or the caller is
 *   not a session;
 * - a create or a listing naming a Resource that is not a repo is refused, and
 *   a listing naming no Resource matches nothing;
 * - a taken slug and a full Wiki are refused;
 * - a session needs `wiki.read` to read and `wiki.write` to write, and the
 *   grant is checked before the input;
 * - a deleted repository's pages stay readable;
 * - listings filter by repository and sort newest change first or by title.
 *
 * Sessions need a runner to start on and a workspace with checkouts, so the
 * fleet is the workspaces domain's.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SessionStart } from "@hercule/protocol";
import type { WikiPage, WikiPageSummary, WikiPageWithRevisions } from "@hercule/contract";
import { del, get, post, readErrorBody, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  createProfile,
  readProfileNamed,
  readSessionToken,
  spawnThreadUnder,
  type Arranged,
} from "../sessions/testing";
import { createRepo, spawnWithCheckouts, withFleet } from "../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const WEB_REMOTE = "https://github.com/acme/web.git";
const API_REMOTE = "https://github.com/acme/api.git";

/** A well-formed id that no Resource has. */
const UNKNOWN_ID = "0199e0e7-0000-7000-8000-00000000dead";

/** The fields of a valid create, besides the Resource. */
const PAGE = {
  slug: "release-process",
  title: "Release process",
  summary: "How a release is cut",
  body: "Tag main, then run the release workflow.",
};

/** Sends `wikiPage.create` with `token`, the user's by default, and returns the raw response. */
const requestCreate = (arranged: Arranged, body: unknown, token = arranged.token) =>
  post(arranged.harness.base, "/api/v1/wiki-pages", body, token);

/** Creates a page and returns it, failing the test when the create is refused. */
const createPage = async (
  arranged: Arranged,
  body: Record<string, unknown>,
  token = arranged.token,
): Promise<WikiPage> => {
  const response = await requestCreate(arranged, { ...PAGE, ...body }, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WikiPage;
};

/** Sends `wikiPage.update` and returns the raw response. */
const requestUpdate = (arranged: Arranged, id: string, body: unknown, token = arranged.token) =>
  send("PATCH", arranged.harness.base, `/api/v1/wiki-pages/${id}`, { body, token });

/** Reads a page, optionally as of `search` such as `?revision=1`, and returns the raw response. */
const requestRead = (arranged: Arranged, id: string, search = "", token = arranged.token) =>
  get(arranged.harness.base, `/api/v1/wiki-pages/${id}${search}`, token);

const readPage = async (
  arranged: Arranged,
  id: string,
  search = "",
): Promise<WikiPageWithRevisions> => {
  const response = await requestRead(arranged, id, search);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WikiPageWithRevisions;
};

/** Lists pages with the query string `search` and returns their slugs, in order. */
const listSlugs = async (arranged: Arranged, search = ""): Promise<ReadonlyArray<string>> => {
  const response = await get(arranged.harness.base, `/api/v1/wiki-pages${search}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { items: ReadonlyArray<WikiPageSummary> };
  return items.map((page) => page.slug);
};

/** Runs a statement against the controller's database, for state no operation can reach cheaply. */
const runSql = (statement: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.orDie(statement));

/** Returns the id and the token of the session a start frame starts. */
const readSessionCredentials = (frame: SessionStart) => ({
  sessionId: frame.sessionId,
  token: readSessionToken(frame),
});

describe("the Wiki over HTTP", () => {
  it("refuses an update from a stale read, and keeps every revision readable", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, WEB_REMOTE);
      const created = await createPage(arranged, { resourceId });
      expect(created).toMatchObject({ revision: 1, repository: "github.com/acme/web" });

      // Two writers read revision 1; the first update wins.
      const first = await requestUpdate(arranged, created.id, {
        expectedRevision: 1,
        body: "Tag main, run the release workflow, then announce it.",
      });
      expect(first.status, await first.clone().text()).toBe(200);
      expect((await first.json()) as WikiPage).toMatchObject({
        revision: 2,
        title: PAGE.title,
        summary: PAGE.summary,
      });

      const stale = await requestUpdate(arranged, created.id, {
        expectedRevision: 1,
        body: "From a stale copy.",
      });
      expect(stale.status).toBe(409);
      expect(await readErrorBody(stale)).toMatchObject({
        code: "conflict",
        message:
          "The page changed since you read it (now revision 2). Read it again, merge your change into it, and update with `--expected-revision 2`.",
      });

      const current = await readPage(arranged, created.id);
      expect(current.page).toMatchObject({
        revision: 2,
        body: "Tag main, run the release workflow, then announce it.",
      });
      expect(current.revisions.map((one) => one.revision)).toEqual([2, 1]);

      const original = await readPage(arranged, created.id, "?revision=1");
      expect(original.page).toMatchObject({ revision: 1, body: PAGE.body });

      const missing = await requestRead(arranged, created.id, "?revision=3");
      expect(missing.status).toBe(404);

      // The log holds ids only: every actor holding event.read reads it.
      const written = await arranged.harness.audit("wikiPage.written");
      expect(written.map(({ actor, payload }) => ({ actor, payload }))).toEqual([
        { actor: "user", payload: { pageId: created.id, resourceId, revision: 1 } },
        { actor: "user", payload: { pageId: created.id, resourceId, revision: 2 } },
      ]);
    });
  });

  it("lists only the 50 newest revisions, newest first", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, WEB_REMOTE);
      const created = await createPage(arranged, { resourceId });
      // 59 updates over HTTP would only slow the test; the revisions are
      // stored as an update stores them.
      const sql = arranged.harness.sql;
      const pageId = created.id.replaceAll("-", "");
      await runSql(
        sql`WITH RECURSIVE n(revision) AS (SELECT 2 UNION ALL SELECT revision + 1 FROM n WHERE revision < 60)
            INSERT INTO wiki_revisions (page_id, revision, title, summary, body, actor, at)
            SELECT unhex(${pageId}), revision, 'Release process', 'How a release is cut',
                   'Revision ' || revision, 'user', '2026-10-14T10:00:00.000Z' FROM n`,
      );
      await runSql(sql`UPDATE wiki_pages SET revision = 60 WHERE id = unhex(${pageId})`);

      const { page, revisions } = await readPage(arranged, created.id);
      expect(page).toMatchObject({ revision: 60, body: "Revision 60" });
      expect(revisions).toHaveLength(50);
      expect(revisions[0]!.revision).toBe(60);
      expect(revisions.at(-1)!.revision).toBe(11);
      // A revision past the listed ones is still readable.
      expect((await readPage(arranged, created.id, "?revision=1")).page.body).toBe(PAGE.body);
    });
  });

  it("takes the one repository a session has checked out, and refuses when there is no single one", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, WEB_REMOTE);
      const api = await createRepo(arranged, API_REMOTE);
      const worker = await readProfileNamed(arranged, "worker");

      const single = await spawnWithCheckouts(arranged, worker.id, [web]).then(
        readSessionCredentials,
      );
      const page = await createPage(arranged, {}, single.token);
      expect(page).toMatchObject({
        resourceId: web,
        repository: "github.com/acme/web",
        updatedBy: `session:${single.sessionId}`,
      });
      const [entry] = await arranged.harness.audit("wikiPage.written");
      expect(entry!.actor).toBe(`session:${single.sessionId}`);

      const both = await spawnWithCheckouts(arranged, worker.id, [web, api]).then(
        readSessionCredentials,
      );
      const several = await requestCreate(arranged, { ...PAGE, slug: "several" }, both.token);
      expect(several.status).toBe(400);
      const severalError = await readErrorBody(several);
      expect(severalError.issues).toEqual([["resourceId"]]);
      expect(severalError.text).toContain(`github.com/acme/web (${web})`);
      expect(severalError.text).toContain(`github.com/acme/api (${api})`);

      const none = await spawnThreadUnder(arranged, worker);
      const unchecked = await requestCreate(arranged, { ...PAGE, slug: "none" }, none.token);
      expect(unchecked.status).toBe(400);
      expect((await readErrorBody(unchecked)).issues).toEqual([["resourceId"]]);

      const fromUser = await requestCreate(arranged, { ...PAGE, slug: "from-user" });
      expect(fromUser.status).toBe(400);
      expect((await readErrorBody(fromUser)).issues).toEqual([["resourceId"]]);

      expect(await listSlugs(arranged)).toEqual([PAGE.slug]);
    });
  });

  it("refuses a Resource that is not a repo with 400, and one that does not exist with 404", async () => {
    await withFleet(async (arranged) => {
      const folder = await post(
        arranged.harness.base,
        "/api/v1/resources",
        { kind: "folder", label: "Notes" },
        arranged.token,
      );
      expect([200, 201], await folder.clone().text()).toContain(folder.status);
      const folderId = ((await folder.json()) as { id: string }).id;

      const notRepo = await requestCreate(arranged, { ...PAGE, resourceId: folderId });
      expect(notRepo.status).toBe(400);
      expect((await readErrorBody(notRepo)).issues).toEqual([["resourceId"]]);

      const unknown = await requestCreate(arranged, { ...PAGE, resourceId: UNKNOWN_ID });
      expect(unknown.status).toBe(404);

      // A listing refuses a Resource that is not a repo too, but one that does
      // not exist only matches no page.
      const listedFolder = await get(
        arranged.harness.base,
        `/api/v1/wiki-pages?resourceId=${folderId}`,
        arranged.token,
      );
      expect(listedFolder.status).toBe(400);
      expect((await readErrorBody(listedFolder)).issues).toEqual([["resourceId"]]);
      expect(await listSlugs(arranged, `?resourceId=${UNKNOWN_ID}`)).toEqual([]);
    });
  });

  it("refuses a taken slug and a Wiki that already holds 500 pages", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, WEB_REMOTE);
      const existing = await createPage(arranged, { resourceId });

      const taken = await requestCreate(arranged, { ...PAGE, resourceId });
      expect(taken.status).toBe(409);
      expect(await readErrorBody(taken)).toMatchObject({
        code: "conflict",
        message: `A page with this slug already exists: ${existing.id}. Read it with \`hercule wiki-page read ${existing.id}\`, then change it with \`hercule wiki-page update\`.`,
      });

      // 499 creates over HTTP would only slow the test; the cap counts rows.
      await runSql(
        arranged.harness
          .sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
          INSERT INTO wiki_pages (id, resource_id, repository, slug, title, summary, revision,
                                  updated_at, updated_by, created_at)
          SELECT randomblob(16), unhex(${resourceId.replaceAll("-", "")}), 'github.com/acme/web',
                 'seeded-' || i, 'Seeded', 'Seeded', 1, '2026-10-14T10:00:00.000Z', 'user',
                 '2026-10-14T10:00:00.000Z' FROM n`,
      );
      const full = await requestCreate(arranged, { ...PAGE, slug: "one-too-many", resourceId });
      expect(full.status).toBe(422);
      expect((await readErrorBody(full)).code).toBe("cap_exceeded");

      // Another repository's Wiki has room of its own.
      const other = await createRepo(arranged, API_REMOTE);
      await createPage(arranged, { slug: "one-too-many", resourceId: other });
    });
  });

  it("refuses a session without wiki.read to read, and one without wiki.write to write", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, WEB_REMOTE);
      const page = await createPage(arranged, { resourceId });

      const reader = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "wiki-reader", ["wiki.read"]),
      );
      expect((await requestRead(arranged, page.id, "", reader.token)).status).toBe(200);
      const created = await requestCreate(arranged, { ...PAGE, resourceId }, reader.token);
      expect(await readErrorBody(created)).toMatchObject({
        code: "forbidden",
        grant: "wiki.write",
      });
      const updated = await requestUpdate(
        arranged,
        page.id,
        { expectedRevision: 1, body: "x" },
        reader.token,
      );
      expect(await readErrorBody(updated)).toMatchObject({
        code: "forbidden",
        grant: "wiki.write",
      });

      // The grant is checked before the input, so an invalid create is still forbidden.
      const invalid = await requestCreate(arranged, { slug: "" }, reader.token);
      expect(invalid.status).toBe(403);
      expect(await readErrorBody(invalid)).toMatchObject({
        code: "forbidden",
        grant: "wiki.write",
      });

      const writer = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "wiki-writer", ["wiki.write"]),
      );
      const read = await requestRead(arranged, page.id, "", writer.token);
      expect(await readErrorBody(read)).toMatchObject({ code: "forbidden", grant: "wiki.read" });
      const listed = await get(arranged.harness.base, "/api/v1/wiki-pages", writer.token);
      expect(await readErrorBody(listed)).toMatchObject({ code: "forbidden", grant: "wiki.read" });

      expect((await readPage(arranged, page.id)).page.revision).toBe(1);
    });
  });

  it("keeps a deleted repository's pages readable, with the repository's name", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, WEB_REMOTE);
      const page = await createPage(arranged, { resourceId });

      const deleted = await del(
        arranged.harness.base,
        `/api/v1/resources/${resourceId}`,
        arranged.token,
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      expect((await readPage(arranged, page.id)).page).toMatchObject({
        resourceId,
        repository: "github.com/acme/web",
        body: PAGE.body,
      });
      expect(await listSlugs(arranged, `?resourceId=${resourceId}`)).toEqual([PAGE.slug]);
    });
  });

  it("lists the most recently changed pages first, of one repository or of all, or by title", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, WEB_REMOTE);
      const api = await createRepo(arranged, API_REMOTE);
      const alpha = await createPage(arranged, { resourceId: web, slug: "alpha", title: "Alpha" });
      await createPage(arranged, { resourceId: web, slug: "bravo", title: "Bravo" });
      await createPage(arranged, { resourceId: api, slug: "charlie", title: "Charlie" });
      const touched = await requestUpdate(arranged, alpha.id, { expectedRevision: 1, body: "new" });
      expect(touched.status, await touched.clone().text()).toBe(200);

      expect(await listSlugs(arranged)).toEqual(["alpha", "charlie", "bravo"]);
      expect(await listSlugs(arranged, `?resourceId=${web}`)).toEqual(["alpha", "bravo"]);
      expect(await listSlugs(arranged, "?sort=title:desc")).toEqual(["charlie", "bravo", "alpha"]);
    });
  });
});
