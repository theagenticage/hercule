import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_SYSTEM_POSTS, toIdTail, type Grant } from "@hercule/contract";
import { CurrentActor, SYSTEM_ACTOR, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { DiscussionService, DiscussionServiceLayer } from "../discussions";
import { discussionRepository } from "../discussions/repository";
import { AuditLogLayer } from "../events";
import { sessionRepository } from "../sessions";
import { EditOverlapService, EditOverlapServiceLayer } from "./index";

const AT = "2026-10-14T00:00:00.000Z";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const DISCUSSION_GRANTS: ReadonlyArray<Grant> = ["discussion.read", "discussion.write"];

const mintId = () => uuidToString(mintUuid());

type Deps = EditOverlapService | DiscussionService | SqlClient.SqlClient;

/** Runs an effect against a fresh database, as the user, and returns its value. */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) => {
  const layer = EditOverlapServiceLayer.pipe(
    Layer.provideMerge(DiscussionServiceLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );
  return Effect.runPromise(
    Effect.provideService(effect, CurrentActor, USER).pipe(
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );
};

/** Inserts a permission profile holding the grants, and returns its id. */
const insertProfile = (grants: ReadonlyArray<Grant>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintId();
    yield* sql`
      INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
      VALUES (${uuidFromString(id)}, ${id}, ${JSON.stringify(grants)}, 0, ${AT}, ${AT})
    `;
    return id;
  });

/** Inserts a repo Resource and returns its id. */
const insertRepository = (canonicalRemote = `github.com/acme/${mintId()}`) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintId();
    yield* sql`
      INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
      VALUES (${uuidFromString(id)}, 'repo', ${`https://${canonicalRemote}`}, ${canonicalRemote}, 1,
              ${AT}, ${AT})
    `;
    return id;
  });

/** Inserts a workspace with a checkout of each Resource, and returns the workspace's id. */
const insertWorkspace = (resourceIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runner = mintUuid();
    const workspace = mintUuid();
    yield* sql`
      INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                           created_at, updated_at)
      VALUES (${runner}, ${mintId()}, 'online', 'active', 0, '{}', ${mintId()}, ${AT}, ${AT})
    `;
    yield* sql`
      INSERT INTO workspaces (id, runner_id, kind, status, created_at)
      VALUES (${workspace}, ${runner}, 'primary', 'ready', ${AT})
    `;
    yield* Effect.forEach(
      resourceIds,
      (resourceId, position) =>
        sql`
        INSERT INTO checkouts (id, workspace_id, resource_id, form, branches, position, created_at)
        VALUES (${mintUuid()}, ${workspace}, ${uuidFromString(resourceId)}, 'clone', '[]',
                ${position}, ${AT})
      `,
    );
    return uuidToString(workspace);
  });

/**
 * Inserts a Thread whose workspace checks out the repositories, and returns
 * its id. It can receive a Discussion Input unless `toldable` is false.
 */
const insertThread = (repositories: ReadonlyArray<string>, toldable = true) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const profileId = toldable ? yield* insertProfile(DISCUSSION_GRANTS) : mintId();
    const id = mintId();
    yield* sessions.insert({
      id,
      title: "a session",
      permissionProfileId: profileId,
      agentId: undefined,
      conversationId: undefined,
      step: undefined,
      instanceId: mintId(),
      runnerId: mintId(),
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      workspaceId: yield* insertWorkspace(repositories),
      projectId: undefined,
      checkoutBranch: undefined,
      githubConnectionId: undefined,
      spec: "{}",
      modelSelection: { model: "clever", options: {} },
      parentSessionId: undefined,
      createdBy: "user",
      at: AT,
    });
    return id;
  });

/** Marks a Thread Done, or reopens it. */
const setDone = (sessionId: string, done: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE sessions SET done_at = ${done ? AT : null}, done_by = ${done ? "user" : null}
      WHERE id = ${uuidFromString(sessionId)}
    `;
  });

/** Reports one edited file of a session. */
const edit = (sessionId: string, resourceId: string, path: string) =>
  Effect.flatMap(EditOverlapService, (service) =>
    service.recordEdits(sessionId, [{ resourceId, path }]),
  );

/** Reads every overlap Discussion of the repository with its Posts, the oldest first. */
const readOverlaps = (resourceId: string) =>
  Effect.gen(function* () {
    const service = yield* DiscussionService;
    const page = yield* service.query({ resourceId, kind: "overlap" });
    return yield* Effect.forEach(
      [...page.items].sort((left, right) => left.id.localeCompare(right.id)),
      (item) => service.read(item.id),
    );
  });

/** Counts the rows `session_edits` holds. */
const countEdits = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM session_edits`;
  return rows[0]!.total;
});

describe("EditOverlapService.recordEdits", () => {
  it("opens one Discussion for two sessions, shares the file and writes one system Post", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository("github.com/acme/web");
        const first = yield* insertThread([repo]);
        const second = yield* insertThread([repo]);
        const alone = yield* edit(first, repo, "src/a.ts");
        const joined = yield* edit(second, repo, "src/a.ts");
        const [only, ...rest] = yield* readOverlaps(repo);
        return { first, second, alone, joined, only, rest };
      }),
    );
    expect(value.alone).toEqual([]);
    expect(value.joined).toEqual([value.second, value.first]);
    expect(value.rest).toEqual([]);
    const { discussion, posts } = value.only!;
    expect(discussion.subject).toBe("Edits overlap in `src/a.ts`");
    expect(discussion.repository).toBe("github.com/acme/web");
    expect(discussion.participantSessionIds).toEqual([value.second, value.first]);
    expect(discussion.sharedFiles.map(({ path, sessionIds }) => ({ path, sessionIds }))).toEqual([
      { path: "src/a.ts", sessionIds: [value.first, value.second] },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.actor).toBe(SYSTEM_ACTOR);
    expect(posts[0]!.text).toBe(
      `Shared files: \`src/a.ts\` (session ${toIdTail(value.first)}, session ${toIdTail(value.second)}).`,
    );
  });

  it("puts a third session into the same Discussion", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const [a, b, c] = [
          yield* insertThread([repo]),
          yield* insertThread([repo]),
          yield* insertThread([repo]),
        ];
        yield* edit(a, repo, "x.ts");
        yield* edit(b, repo, "x.ts");
        const joined = yield* edit(c, repo, "x.ts");
        return { a, b, c, joined, discussions: yield* readOverlaps(repo) };
      }),
    );
    expect(value.joined).toEqual([value.c]);
    expect(value.discussions).toHaveLength(1);
    const { discussion, posts } = value.discussions[0]!;
    expect(discussion.participantSessionIds).toEqual([value.b, value.a, value.c]);
    expect(discussion.sharedFiles[0]!.sessionIds).toEqual([value.a, value.b, value.c]);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.text).toBe(`Shared files: \`x.ts\` (session ${toIdTail(value.c)}).`);
  });

  it("changes nothing when the same edit is reported again", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        const b = yield* insertThread([repo]);
        yield* edit(a, repo, "x.ts");
        yield* edit(b, repo, "x.ts");
        const again = yield* edit(b, repo, "x.ts");
        const againFirst = yield* edit(a, repo, "x.ts");
        return {
          again,
          againFirst,
          discussions: yield* readOverlaps(repo),
          edits: yield* countEdits,
        };
      }),
    );
    expect(value.again).toEqual([]);
    expect(value.againFirst).toEqual([]);
    expect(value.discussions).toHaveLength(1);
    expect(value.discussions[0]!.posts).toHaveLength(1);
    expect(value.edits).toBe(2);
  });

  it("never overlaps a session with itself", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        yield* edit(a, repo, "x.ts");
        const again = yield* edit(a, repo, "x.ts");
        return { again, discussions: yield* readOverlaps(repo) };
      }),
    );
    expect(value.again).toEqual([]);
    expect(value.discussions).toEqual([]);
  });

  it("records the edits of a finished session and starts no overlap", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        const b = yield* insertThread([repo]);
        yield* edit(a, repo, "x.ts");
        yield* setDone(b, true);
        const finished = yield* edit(b, repo, "x.ts");
        return { finished, discussions: yield* readOverlaps(repo), edits: yield* countEdits };
      }),
    );
    expect(value.finished).toEqual([]);
    expect(value.discussions).toEqual([]);
    expect(value.edits).toBe(2);
  });

  it("does not count the edit of a finished session as an overlap", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        const b = yield* insertThread([repo]);
        yield* edit(a, repo, "x.ts");
        yield* setDone(a, true);
        const joined = yield* edit(b, repo, "x.ts");
        return { joined, discussions: yield* readOverlaps(repo) };
      }),
    );
    expect(value.joined).toEqual([]);
    expect(value.discussions).toEqual([]);
  });

  it("ignores a file of a repository that is not checked out", async () => {
    const value = await run(
      Effect.gen(function* () {
        const checkedOut = yield* insertRepository();
        const elsewhere = yield* insertRepository();
        const a = yield* insertThread([checkedOut]);
        const b = yield* insertThread([checkedOut, elsewhere]);
        yield* edit(a, elsewhere, "x.ts");
        const joined = yield* edit(b, elsewhere, "x.ts");
        return { joined, discussions: yield* readOverlaps(elsewhere), edits: yield* countEdits };
      }),
    );
    expect(value.joined).toEqual([]);
    expect(value.discussions).toEqual([]);
    expect(value.edits).toBe(1);
  });

  it("says in the system Post which session was not told, and why", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const quiet = yield* insertThread([repo], false);
        const told = yield* insertThread([repo]);
        yield* edit(quiet, repo, "x.ts");
        yield* edit(told, repo, "x.ts");
        return { quiet, told, discussions: yield* readOverlaps(repo) };
      }),
    );
    const post = value.discussions[0]!.posts[0]!;
    expect(post.text).toBe(
      `Shared files: \`x.ts\` (session ${toIdTail(value.quiet)}, session ${toIdTail(value.told)}).\n` +
        `Session ${toIdTail(value.quiet)} was not told: it lacks the discussion grants.`,
    );
  });

  it("opens a new Discussion when the oldest one is full", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const [a, b, c] = [
          yield* insertThread([repo]),
          yield* insertThread([repo]),
          yield* insertThread([repo]),
        ];
        yield* edit(a, repo, "x.ts");
        yield* edit(b, repo, "x.ts");
        const [first] = yield* readOverlaps(repo);
        const posts = yield* discussionRepository;
        for (let index = 0; index < MAX_SYSTEM_POSTS; index++) {
          yield* posts.insertPost({
            id: mintId(),
            discussionId: first!.discussion.id,
            actor: SYSTEM_ACTOR,
            text: "a post",
            createdAt: AT,
          });
        }
        const joined = yield* edit(c, repo, "x.ts");
        return { a, b, c, joined, first: first!, discussions: yield* readOverlaps(repo) };
      }),
    );
    expect(value.joined).toEqual([value.c, value.b, value.a]);
    expect(value.discussions).toHaveLength(2);
    expect(value.discussions[0]!.discussion.id).toBe(value.first.discussion.id);
    expect(value.discussions[0]!.discussion.participantSessionIds).toEqual([value.b, value.a]);
    expect(value.discussions[1]!.discussion.participantSessionIds).toEqual([
      value.c,
      value.b,
      value.a,
    ]);
  });

  it("links the other Discussion an overlapping session takes part in", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const [a, b, c, d] = [
          yield* insertThread([repo]),
          yield* insertThread([repo]),
          yield* insertThread([repo]),
          yield* insertThread([repo]),
        ];
        yield* edit(a, repo, "one.ts");
        yield* edit(b, repo, "one.ts");
        yield* edit(c, repo, "two.ts");
        yield* edit(d, repo, "two.ts");
        yield* edit(a, repo, "three.ts");
        const joined = yield* edit(c, repo, "three.ts");
        return { a, c, joined, discussions: yield* readOverlaps(repo) };
      }),
    );
    const [one, two] = value.discussions;
    expect(value.joined).toEqual([value.a]);
    expect(two!.discussion.participantSessionIds).toContain(value.a);
    expect(one!.posts).toHaveLength(2);
    expect(one!.posts[1]!.text).toBe(
      `Session ${toIdTail(value.c)} also overlaps with sessions in discussion ${two!.discussion.id} ` +
        `("${two!.discussion.subject}"). Continue there.`,
    );
  });

  it("writes one system Post per Discussion for a report of several files", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        const b = yield* insertThread([repo]);
        yield* Effect.flatMap(EditOverlapService, (service) =>
          service.recordEdits(a, [
            { resourceId: repo, path: "one.ts" },
            { resourceId: repo, path: "two.ts" },
          ]),
        );
        const joined = yield* Effect.flatMap(EditOverlapService, (service) =>
          service.recordEdits(b, [
            { resourceId: repo, path: "one.ts" },
            { resourceId: repo, path: "two.ts" },
          ]),
        );
        return { a, b, joined, discussions: yield* readOverlaps(repo) };
      }),
    );
    expect(value.joined).toEqual([value.b, value.a]);
    expect(value.discussions).toHaveLength(1);
    const { discussion, posts } = value.discussions[0]!;
    expect(discussion.sharedFiles.map((file) => file.path)).toEqual(["one.ts", "two.ts"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("`one.ts`");
    expect(posts[0]!.text).toContain("`two.ts`");
  });
});

describe("EditOverlapService.rejoinOverlaps", () => {
  it("meets the session that edited the file while this one was finished", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        const b = yield* insertThread([repo]);
        yield* edit(a, repo, "x.ts");
        yield* setDone(a, true);
        yield* edit(b, repo, "x.ts");
        const whileDone = yield* readOverlaps(repo);
        yield* setDone(a, false);
        const service = yield* EditOverlapService;
        const joined = yield* service.rejoinOverlaps(a);
        const again = yield* service.rejoinOverlaps(a);
        return { a, b, whileDone, joined, again, discussions: yield* readOverlaps(repo) };
      }),
    );
    expect(value.whileDone).toEqual([]);
    expect(value.joined).toEqual([value.a, value.b]);
    expect(value.again).toEqual([]);
    expect(value.discussions).toHaveLength(1);
    expect(value.discussions[0]!.discussion.sharedFiles[0]!.sessionIds).toEqual([value.a, value.b]);
  });

  it("does nothing for a session that is still finished", async () => {
    const value = await run(
      Effect.gen(function* () {
        const repo = yield* insertRepository();
        const a = yield* insertThread([repo]);
        const b = yield* insertThread([repo]);
        yield* edit(a, repo, "x.ts");
        yield* edit(b, repo, "x.ts");
        yield* setDone(a, true);
        const service = yield* EditOverlapService;
        return yield* service.rejoinOverlaps(a);
      }),
    );
    expect(value).toEqual([]);
  });
});
