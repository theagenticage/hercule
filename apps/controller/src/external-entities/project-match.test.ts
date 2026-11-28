/**
 * Tests that the Project a set of things points at is found from the
 * repositories of the things, and of the things linked to them, against a
 * migrated database. Every body runs in one transaction on a fresh database.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ProjectMatch } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { makeProjectMatcher } from "./project-match";

const AT = "2026-11-01T09:00:00.000Z";
const ACCOUNT = "0190c000-0000-7000-8000-0000000000a1";
const SHOP = "github.com/acme/shop";
const DOCS = "github.com/acme/docs";

const run = <A>(body: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES ('acme', 1, '{}', ${AT}, ${AT})`;
      yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
          status, labels, config, created_at, updated_at)
        VALUES (${uuidFromString(ACCOUNT)}, 'acme', 'acme/account', 'work', 'work', 'work',
          'connected', '[]', '{}', ${AT}, ${AT})`;
      return yield* body;
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

/** Matches the things the same way the service does, with the SQL client of the test. */
const match = (ids: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => makeProjectMatcher(sql).matchProject({ ids }));

interface Thing {
  readonly id: string;
  readonly ref: string;
}

interface ThingOptions {
  readonly remote?: string;
  readonly identifier?: string;
  readonly title?: string;
  /** Whether some Connection reads the record. Default true. */
  readonly readable?: boolean;
}

/** Writes a pull request, and returns its id and ref. */
const insertThing = (key: string, options: ThingOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = uuidToString(mintUuid());
    const ref = `acme:pr:${key}`;
    yield* sql`
      INSERT INTO external_entities
        (id, ref, kind, noun, card, pace, completeness, identifier, title, repository,
         first_observed_at, updated_at)
      VALUES (${uuidFromString(id)}, ${ref}, 'acme/pr', 'Pull request', 'rich', 'fast', 'full',
        ${options.identifier ?? `#${key}`}, ${options.title ?? `Pull request ${key}`},
        ${options.remote === undefined ? null : JSON.stringify({ target: { remote: options.remote } })},
        ${AT}, ${AT})`;
    yield* sql`
      INSERT INTO external_entity_observations (ref, connection_id, access)
      VALUES (${ref}, ${uuidFromString(ACCOUNT)}, ${options.readable === false ? "inaccessible" : "ok"})`;
    return { id, ref } satisfies Thing;
  });

/** Links two things as the user, which joins them. */
const link = (from: Thing, to: Thing) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO external_entity_relation_claims
        (from_ref, relation, to_ref, claim_type, actor, evidence_key, state, observed_at)
      VALUES (${from.ref}, 'linked', ${to.ref}, 'person', 'user', '', 'current', ${AT})`,
  );

/** Files a Resource with this canonical remote under a new Project, or under `projectId`. Returns both ids. */
const fileRepository = (
  remote: string,
  name: string,
  options: { readonly deleted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = uuidToString(mintUuid());
    yield* sql`INSERT INTO projects (id, name, deleted_at, created_at, updated_at)
      VALUES (${uuidFromString(projectId)}, ${name}, ${options.deleted === true ? AT : null}, ${AT}, ${AT})`;
    const resourceId = yield* insertResource(remote);
    yield* fileUnder(projectId, resourceId);
    return { projectId, resourceId };
  });

const insertResource = (remote: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = uuidToString(mintUuid());
    yield* sql`INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
      VALUES (${uuidFromString(id)}, 'repo', ${`https://${remote}`}, ${remote}, 1, ${AT}, ${AT})`;
    return id;
  });

const fileUnder = (projectId: string, resourceId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO project_resources (project_id, resource_id)
      VALUES (${uuidFromString(projectId)}, ${uuidFromString(resourceId)})`,
  );

describe("matching the Project of things", () => {
  it("matches a thing's own repository to the Project that holds it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const shop = yield* fileRepository(SHOP, "Shop");
        const pr = yield* insertThing("6244", { remote: SHOP, title: "Fix the cart" });
        const reply = yield* match([pr.id]);
        return { reply, shop, pr };
      }),
    );

    expect(result.reply).toEqual({
      kind: "matched",
      projectId: result.shop.projectId,
      resourceId: result.shop.resourceId,
      thing: { id: result.pr.id, identifier: "#6244", title: "Fix the cart" },
    });
  });

  it("matches a linked thing's repository and names that thing as the way in", async () => {
    const result = await run(
      Effect.gen(function* () {
        const shop = yield* fileRepository(SHOP, "Shop");
        const ticket = yield* insertThing("SHOP-142", { title: "Cart is empty" });
        const pr = yield* insertThing("6244", { remote: SHOP, title: "Fix the cart" });
        yield* link(ticket, pr);
        return { reply: yield* match([ticket.id]), shop, ticket, pr };
      }),
    );

    expect(result.reply).toEqual({
      kind: "matched",
      projectId: result.shop.projectId,
      resourceId: result.shop.resourceId,
      thing: { id: result.ticket.id, identifier: "#SHOP-142", title: "Cart is empty" },
      via: { id: result.pr.id, identifier: "#6244", title: "Fix the cart" },
    });
  });

  it("reads a link in both directions", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        const ticket = yield* insertThing("1");
        const pr = yield* insertThing("2", { remote: SHOP });
        yield* link(pr, ticket);
        return yield* match([ticket.id]);
      }),
    );

    expect(reply).toMatchObject({ kind: "matched", via: { identifier: "#2" } });
  });

  it("prefers a thing's own repository over a linked one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const shop = yield* fileRepository(SHOP, "Shop");
        yield* fileRepository(DOCS, "Docs");
        const own = yield* insertThing("1", { remote: SHOP });
        const other = yield* insertThing("2");
        const linkedElsewhere = yield* insertThing("3", { remote: DOCS });
        yield* link(other, linkedElsewhere);
        return { reply: yield* match([other.id, own.id]), shop, own };
      }),
    );

    expect(result.reply).toEqual({
      kind: "matched",
      projectId: result.shop.projectId,
      resourceId: result.shop.resourceId,
      thing: { id: result.own.id, identifier: "#1", title: "Pull request 1" },
    });
  });

  it("names the first selected thing, in the order given, that has the evidence", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        const first = yield* insertThing("1", { remote: SHOP });
        const second = yield* insertThing("2", { remote: SHOP });
        return {
          forward: yield* match([first.id, second.id]),
          backward: yield* match([second.id, first.id]),
        };
      }),
    );

    expect(result.forward).toMatchObject({ kind: "matched", thing: { identifier: "#1" } });
    expect(result.backward).toMatchObject({ kind: "matched", thing: { identifier: "#2" } });
  });

  it("is ambiguous when two things point at two Projects", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        yield* fileRepository(DOCS, "Docs");
        const a = yield* insertThing("1", { remote: SHOP });
        const b = yield* insertThing("2", { remote: DOCS });
        return yield* match([a.id, b.id]);
      }),
    );

    expect(reply).toEqual({ kind: "ambiguous" });
  });

  it("is ambiguous when two linked things point at two Projects", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        yield* fileRepository(DOCS, "Docs");
        const ticket = yield* insertThing("1");
        yield* link(ticket, yield* insertThing("2", { remote: SHOP }));
        yield* link(ticket, yield* insertThing("3", { remote: DOCS }));
        return yield* match([ticket.id]);
      }),
    );

    expect(reply).toEqual({ kind: "ambiguous" });
  });

  it("is ambiguous when one remote is filed under two Projects", async () => {
    const reply = await run(
      Effect.gen(function* () {
        const shop = yield* fileRepository(SHOP, "Shop");
        const second = uuidToString(mintUuid());
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projects (id, name, created_at, updated_at)
          VALUES (${uuidFromString(second)}, 'Shop too', ${AT}, ${AT})`;
        yield* fileUnder(second, shop.resourceId);
        const pr = yield* insertThing("1", { remote: SHOP });
        return yield* match([pr.id]);
      }),
    );

    expect(reply).toEqual({ kind: "ambiguous" });
  });

  it("is none when no repository is filed under a Project, or the things have none", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        const unfiled = yield* insertThing("1", { remote: DOCS });
        const bare = yield* insertThing("2");
        const linked = yield* insertThing("3", { remote: DOCS });
        yield* link(bare, linked);
        return yield* match([unfiled.id, bare.id]);
      }),
    );

    expect(reply).toEqual({ kind: "none" });
  });

  it("ignores a deleted Project and a deleted Resource", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop", { deleted: true });
        const gone = yield* insertResource(DOCS);
        const sql = yield* SqlClient.SqlClient;
        // A Resource that is deleted loses its rows, as `resources.delete` removes them.
        yield* sql`DELETE FROM resources WHERE id = ${uuidFromString(gone)}`;
        const inShop = yield* insertThing("1", { remote: SHOP });
        const inDocs = yield* insertThing("2", { remote: DOCS });
        return { shop: yield* match([inShop.id]), docs: yield* match([inDocs.id]) };
      }),
    );

    expect(result).toEqual({ shop: { kind: "none" }, docs: { kind: "none" } });
  });

  it("falls back to linked things when the thing's own repository is of a deleted Project", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop", { deleted: true });
        const live = yield* fileRepository(DOCS, "Docs");
        const own = yield* insertThing("1", { remote: SHOP });
        yield* link(own, yield* insertThing("2", { remote: DOCS }));
        return { reply: yield* match([own.id]), live };
      }),
    );

    expect(reply.reply).toMatchObject({ kind: "matched", projectId: reply.live.projectId });
  });

  it("leaves out the title of a thing no Connection can read, and keeps its identifier", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        const ticket = yield* insertThing("1");
        const pr = yield* insertThing("2", { remote: SHOP, readable: false });
        yield* link(ticket, pr);
        return yield* match([ticket.id]);
      }),
    );

    expect(reply).toMatchObject({ kind: "matched", via: { identifier: "#2" } });
    expect((reply as Extract<ProjectMatch, { kind: "matched" }>).via).not.toHaveProperty("title");
  });

  it("ignores a hint that only text holds, and a link that is not yet resolved", async () => {
    const reply = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* fileRepository(SHOP, "Shop");
        const ticket = yield* insertThing("1");
        const pr = yield* insertThing("2", { remote: SHOP });
        yield* sql`
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, evidence_key, state, observed_at)
          VALUES (${ticket.ref}, 'linked', ${pr.ref}, 'text', ${uuidFromString(ACCOUNT)},
            'description', 'current', ${AT})`;
        return yield* match([ticket.id]);
      }),
    );

    expect(reply).toEqual({ kind: "none" });
  });

  it("counts a repeated id once", async () => {
    const reply = await run(
      Effect.gen(function* () {
        yield* fileRepository(SHOP, "Shop");
        const pr = yield* insertThing("1", { remote: SHOP });
        return yield* match([pr.id, pr.id]);
      }),
    );

    expect(reply).toMatchObject({ kind: "matched" });
  });

  it("fails with NotFound naming every unknown id", async () => {
    const unknown = uuidToString(mintUuid());
    const error = await run(
      Effect.gen(function* () {
        const pr = yield* insertThing("1", { remote: SHOP });
        return yield* Effect.flip(match([pr.id, unknown]));
      }),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
    expect(JSON.stringify(error)).toContain(unknown);
  });
});
