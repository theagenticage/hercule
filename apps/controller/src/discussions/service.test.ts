import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  MAX_DISCUSSION_POSTS,
  MAX_PARTICIPANTS,
  MAX_SHARED_FILES,
  MAX_SYSTEM_POSTS,
  toIdTail,
  type Grant,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { buildAnnouncementRecorder, inTransaction, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { sessionRepository } from "../sessions";
import { DiscussionService, DiscussionServiceLayer } from "./index";
import { discussionRepository } from "./repository";

const AT = "2026-10-14T00:00:00.000Z";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const DISCUSSION_GRANTS: ReadonlyArray<Grant> = ["discussion.read", "discussion.write"];

/** A session actor with the discussion grants, or with the grants given. */
const buildSessionActor = (
  sessionId: string,
  grants: ReadonlyArray<Grant> = DISCUSSION_GRANTS,
): Actor => ({
  _tag: "session",
  sessionId,
  profileId: "0199e0e7-0000-7000-8000-0000000000f0",
  grants,
  profileGrants: grants,
  assistantId: null,
  agentId: null,
});

const mintId = () => uuidToString(mintUuid());

type Deps = DiscussionService | SqlClient.SqlClient;

/** Runs an effect as `actor` against a fresh database, and returns its value. */
const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) => {
  const layer = DiscussionServiceLayer.pipe(
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );
  return Effect.runPromise(
    Effect.provideService(effect, CurrentActor, actor).pipe(
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );
};

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) => runAs(USER, effect);

/** Runs a call that is expected to fail as `actor`, and returns its error. */
const runErrorAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) =>
  runAs(actor, Effect.flip(effect));

/** Inserts a permission profile holding the grants, and returns its id. */
const insertProfile = (grants: ReadonlyArray<Grant>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintId();
    yield* withTransaction(
      sql,
      sql`
        INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
        VALUES (${uuidFromString(id)}, ${id}, ${JSON.stringify(grants)}, 0, ${AT}, ${AT})
      `,
    );
    return id;
  });

/**
 * Inserts a session row, which a participant must point at, and returns its
 * id. Its permission profile names no profile row, so it holds no grant.
 */
const insertSession = (workspaceId: string | null = null, permissionProfileId = mintId()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* sessionRepository;
    const id = mintId();
    yield* withTransaction(
      sql,
      sessions.insert({
        id,
        title: "a session",
        role: undefined,
        permissionProfileId,
        agentId: undefined,
        conversationId: undefined,
        step: undefined,
        instanceId: mintId(),
        runnerId: mintId(),
        requestedAccessMode: "approval-required",
        accessMode: "approval-required",
        workspaceId,
        projectId: undefined,
        checkoutBranch: undefined,
        githubConnectionId: undefined,
        spec: "{}",
        modelSelection: { model: "clever", options: {} },
        parentSessionId: undefined,
        createdBy: "user",
        at: AT,
      }),
    );
    return id;
  });

/** Inserts a queued session that can receive a Discussion Input, and returns its id. */
const insertToldableSession = () =>
  Effect.flatMap(insertProfile(DISCUSSION_GRANTS), (profileId) => insertSession(null, profileId));

/** Inserts `count` sessions and returns their ids. */
const insertSessions = (count: number) =>
  Effect.forEach(Array.from({ length: count }), () => insertSession());

/** Inserts a Resource of `kind` and returns its id. */
const insertResource = (kind: "repo" | "folder", canonicalRemote = "github.com/acme/web") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintId();
    yield* withTransaction(
      sql,
      sql`
        INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
        VALUES (${uuidFromString(id)}, ${kind},
                ${kind === "repo" ? `https://${canonicalRemote}` : null},
                ${kind === "repo" ? canonicalRemote : null}, ${kind === "repo" ? 1 : 0}, ${AT}, ${AT})
      `,
    );
    return id;
  });

/** Inserts a workspace with a checkout of each Resource, and returns the workspace's id. */
const insertWorkspace = (resourceIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runner = mintUuid();
    const workspace = mintUuid();
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                               created_at, updated_at)
          VALUES (${runner}, 'laptop', 'online', 'active', 0, '{}', 'hash', ${AT}, ${AT})
        `;
        yield* sql`
          INSERT INTO workspaces (id, runner_id, kind, status, created_at)
          VALUES (${workspace}, ${runner}, 'primary', 'ready', ${AT})
        `;
        yield* Effect.forEach(
          resourceIds,
          (resourceId, position) =>
            sql`
            INSERT INTO checkouts (id, workspace_id, resource_id, form, position, created_at)
            VALUES (${mintUuid()}, ${workspace}, ${uuidFromString(resourceId)}, 'clone',
                    ${position}, ${AT})
          `,
        );
      }),
    );
    return uuidToString(workspace);
  });

/** Writes `count` Posts straight into the table, as `actor`, faster than posting each. */
const insertPosts = (discussionId: string, actor: string, count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const discussions = yield* discussionRepository;
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        for (let index = 0; index < count; index++) {
          yield* discussions.insertPost({
            id: mintId(),
            discussionId,
            actor,
            text: "a post",
            createdAt: AT,
          });
        }
      }),
    );
  });

/** Opens a general Discussion as the current actor, about a new repo, and returns its id. */
const openDiscussion = (resourceId?: string) =>
  Effect.gen(function* () {
    const service = yield* DiscussionService;
    const created = yield* service.create({
      resourceId: resourceId ?? (yield* insertResource("repo", `github.com/acme/${mintId()}`)),
      subject: "Who changes the router?",
      text: "I am about to.",
    });
    return created.discussion.id;
  });

/** Returns the message of an API error, the text the caller reads. */
const readMessage = (error: unknown): string =>
  (error as { readonly error: { readonly message: string } }).error.message;

/** Returns the code of an API error, such as `validation`. */
const readCode = (error: unknown): string =>
  (error as { readonly error: { readonly code: string } }).error.code;

describe("discussion.create", () => {
  it("takes the session's one checked-out repository and makes the session a participant", async () => {
    const value = await run(
      Effect.gen(function* () {
        const resourceId = yield* insertResource("repo");
        const sessionId = yield* insertSession(yield* insertWorkspace([resourceId]));
        const created = yield* Effect.provideService(
          Effect.flatMap(DiscussionService, (service) =>
            service.create({ subject: "Router", text: "I will change it." }),
          ),
          CurrentActor,
          buildSessionActor(sessionId),
        );
        return {
          resourceId,
          sessionId,
          created,
          createdEntries: yield* readEventsOfKind("discussion.created"),
          postedEntries: yield* readEventsOfKind("discussion.posted"),
        };
      }),
    );
    const { created, resourceId, sessionId } = value;
    expect(created.discussion).toMatchObject({
      resourceId,
      repository: "github.com/acme/web",
      kind: "general",
      subject: "Router",
      postCount: 1,
      sharedFileCount: 0,
      participantCount: 1,
      sharedFiles: [],
      participantSessionIds: [sessionId],
    });
    expect(created.post).toMatchObject({
      actor: `session:${sessionId}`,
      text: "I will change it.",
    });
    // An audit entry holds ids only, never the Post's text.
    expect(value.createdEntries.map((entry) => [entry.actor, entry.payload])).toEqual([
      [`session:${sessionId}`, { discussionId: created.discussion.id, resourceId }],
    ]);
    expect(value.postedEntries.map((entry) => entry.payload)).toEqual([
      { discussionId: created.discussion.id, postId: created.post.id },
    ]);
  });

  it("refuses a session with two repositories checked out, naming both", async () => {
    const error = await run(
      Effect.gen(function* () {
        const web = yield* insertResource("repo");
        const api = yield* insertResource("repo", "github.com/acme/api");
        const sessionId = yield* insertSession(yield* insertWorkspace([web, api]));
        return yield* Effect.flip(
          Effect.provideService(
            Effect.flatMap(DiscussionService, (service) =>
              service.create({ subject: "Router", text: "x" }),
            ),
            CurrentActor,
            buildSessionActor(sessionId),
          ),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    expect(JSON.stringify(error)).toContain("github.com/acme/api");
  });

  it.each([
    ["a blank subject", { subject: "  ", text: "x" }],
    ["a subject of two lines", { subject: "one\ntwo", text: "x" }],
    ["a subject of 201 characters", { subject: "😀".repeat(201), text: "x" }],
    ["a blank text", { subject: "Router", text: " \n" }],
    ["a text of 8,001 characters", { subject: "Router", text: "😀".repeat(8_001) }],
  ])("refuses %s", async (_, input) => {
    const error = await run(
      Effect.gen(function* () {
        const resourceId = yield* insertResource("repo");
        return yield* Effect.flip(
          Effect.flatMap(DiscussionService, (service) => service.create({ resourceId, ...input })),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("counts lengths in characters, so 200 emoji are a subject and 8,000 a text", async () => {
    const created = await run(
      Effect.gen(function* () {
        const resourceId = yield* insertResource("repo");
        return yield* Effect.flatMap(DiscussionService, (service) =>
          service.create({ resourceId, subject: "😀".repeat(200), text: "😀".repeat(8_000) }),
        );
      }),
    );
    expect(Array.from(created.discussion.subject)).toHaveLength(200);
  });

  it("refuses a Resource that is not a repo, and one that does not exist", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const folder = yield* insertResource("folder");
        const service = yield* DiscussionService;
        return yield* Effect.forEach([folder, mintId()], (resourceId) =>
          Effect.flip(service.create({ resourceId, subject: "Router", text: "x" })),
        );
      }),
    );
    expect(errors.map(readCode)).toEqual(["validation", "not_found"]);
  });

  it("refuses a session without discussion.write before it looks at the input", async () => {
    const error = await runErrorAs(
      buildSessionActor(mintId(), ["discussion.read"]),
      Effect.flatMap(DiscussionService, (service) => service.create({ subject: " ", text: " " })),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("discussion.post", () => {
  it("makes the poster a participant, after the ones that took part already", async () => {
    const value = await run(
      Effect.gen(function* () {
        const [first, second] = yield* insertSessions(2);
        const service = yield* DiscussionService;
        const id = yield* Effect.provideService(
          openDiscussion(),
          CurrentActor,
          buildSessionActor(first!),
        );
        const post = yield* Effect.provideService(
          service.post(id, "I take the tests."),
          CurrentActor,
          buildSessionActor(second!),
        );
        const fromUser = yield* service.post(id, "Thanks, both.");
        return { first, second, id, post, fromUser, read: yield* service.read(id) };
      }),
    );
    const { first, second, post, fromUser, read } = value;
    expect(post.actor).toBe(`session:${second}`);
    expect(read.discussion).toMatchObject({
      postCount: 3,
      participantSessionIds: [first, second],
      lastPostAt: fromUser.createdAt,
    });
  });

  it("refuses the 201st counted Post, and does not count system Posts", async () => {
    const { full, systemPost, read } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const id = yield* openDiscussion();
        yield* insertPosts(id, "user", MAX_DISCUSSION_POSTS - 1);
        yield* insertPosts(id, "system", 5);
        return {
          full: yield* Effect.flip(service.post(id, "one more")),
          systemPost: yield* inTransaction(service.writeSystemPost(id, "Shared files: `a.ts`.")),
          read: yield* service.read(id),
        };
      }),
    );
    expect(full).toMatchObject({
      error: {
        code: "cap_exceeded",
        details: { count: MAX_DISCUSSION_POSTS, cap: MAX_DISCUSSION_POSTS },
      },
    });
    expect(readMessage(full)).toBe(
      "This discussion is full (200 posts). Ask your user how to continue.",
    );
    expect(Option.isSome(systemPost)).toBe(true);
    expect(read.discussion.postCount).toBe(MAX_DISCUSSION_POSTS);
    expect(read.posts).toHaveLength(MAX_DISCUSSION_POSTS + 6);
  });

  it("accepts a Post from a session that does not fit, without adding it", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const id = yield* openDiscussion();
        const sessionIds = yield* insertSessions(MAX_PARTICIPANTS + 1);
        const joined = yield* inTransaction(service.join(id, sessionIds));
        const late = sessionIds[MAX_PARTICIPANTS]!;
        const post = yield* Effect.provideService(
          service.post(id, "May I join?"),
          CurrentActor,
          buildSessionActor(late),
        );
        return { joined, post, late, read: yield* service.read(id) };
      }),
    );
    expect(value.joined.joined).toHaveLength(MAX_PARTICIPANTS);
    expect(value.joined.leftOut).toEqual([value.late]);
    expect(value.post.actor).toBe(`session:${value.late}`);
    expect(value.read.discussion.participantCount).toBe(MAX_PARTICIPANTS);
    expect(value.read.discussion.participantSessionIds).not.toContain(value.late);
  });

  it("refuses an unknown Discussion with not_found, after the text is checked", async () => {
    const errors = await run(
      Effect.flatMap(DiscussionService, (service) =>
        Effect.all([
          Effect.flip(service.post(mintId(), "x")),
          Effect.flip(service.post(mintId(), " ")),
        ]),
      ),
    );
    expect(errors.map(readCode)).toEqual(["not_found", "validation"]);
  });
});

describe("discussion.read", () => {
  it("returns the Posts from fromPostId on, and refuses a Post of another Discussion", async () => {
    const { from, other, missing } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const id = yield* openDiscussion();
        const second = yield* service.post(id, "second");
        yield* service.post(id, "third");
        const elsewhere = yield* service.create({
          resourceId: yield* insertResource("repo"),
          subject: "Other",
          text: "elsewhere",
        });
        return {
          from: yield* service.read(id, second.id),
          other: yield* Effect.flip(service.read(id, elsewhere.post.id)),
          missing: yield* Effect.flip(service.read(mintId())),
        };
      }),
    );
    expect(from.posts.map((post) => post.text)).toEqual(["second", "third"]);
    expect(other).toMatchObject({ error: { code: "validation" } });
    expect(missing).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("discussion.query", () => {
  it("filters by repository, kind and participant, newest last Post first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const web = yield* insertResource("repo");
        const api = yield* insertResource("repo", "github.com/acme/api");
        const [sessionId] = yield* insertSessions(1);
        const older = yield* openDiscussion(web);
        yield* TestClock.adjust("1 second");
        const newer = yield* openDiscussion(web);
        yield* TestClock.adjust("1 second");
        const overlap = yield* inTransaction(
          service.openOverlapDiscussion({
            resourceId: api,
            repository: "github.com/acme/api",
            path: "src/router.ts",
          }),
        );
        yield* inTransaction(service.join(overlap.id, [sessionId!]));
        yield* TestClock.adjust("1 second");
        // A Post moves the older Discussion to the top of the default order.
        yield* service.post(older, "bump");
        const listIds = (input: Parameters<typeof service.query>[0]) =>
          Effect.map(service.query(input), (page) => page.items.map((item) => item.id));
        return {
          older,
          newer,
          overlap: overlap.id,
          all: yield* listIds({}),
          byCreation: yield* listIds({ sort: [{ field: "createdAt" }] }),
          ofWeb: yield* listIds({ resourceId: web }),
          ofKind: yield* listIds({ kind: "overlap" }),
          ofSession: yield* listIds({ sessionId: sessionId! }),
          ofUnknown: yield* listIds({ resourceId: mintId() }),
          ofFolder: yield* Effect.flip(
            service.query({ resourceId: yield* insertResource("folder") }),
          ),
          firstPage: yield* service.query({ limit: 2 }),
        };
      }),
    );
    expect(result.all).toEqual([result.older, result.overlap, result.newer]);
    expect(result.byCreation).toEqual([result.older, result.newer, result.overlap]);
    expect(result.ofWeb).toEqual([result.older, result.newer]);
    expect(result.ofKind).toEqual([result.overlap]);
    expect(result.ofSession).toEqual([result.overlap]);
    expect(result.ofUnknown).toEqual([]);
    expect(result.ofFolder).toMatchObject({ error: { code: "validation" } });
    expect(result.firstPage.items).toHaveLength(2);
    expect(result.firstPage.nextCursor).toBeDefined();
  });

  it("matches nothing for a deleted repository, whose Discussions stay readable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const sql = yield* SqlClient.SqlClient;
        const web = yield* insertResource("repo");
        const id = yield* openDiscussion(web);
        yield* withTransaction(sql, sql`DELETE FROM resources WHERE id = ${uuidFromString(web)}`);
        return {
          id,
          filtered: yield* service.query({ resourceId: web }),
          badCursor: yield* Effect.flip(service.query({ resourceId: web, cursor: "not-a-cursor" })),
          unfiltered: yield* service.query({}),
          read: yield* service.read(id),
        };
      }),
    );
    expect(result.filtered.items).toEqual([]);
    expect(result.badCursor).toMatchObject({ error: { code: "validation" } });
    expect(result.unfiltered.items.map((item) => item.id)).toEqual([result.id]);
    expect(result.read.discussion.repository).toBe("github.com/acme/web");
  });

  it("pages through every Discussion once with the cursor", async () => {
    const pages = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        for (let index = 0; index < 3; index++) yield* openDiscussion();
        const first = yield* service.query({ limit: 2 });
        const second = yield* service.query({ limit: 2, cursor: first.nextCursor! });
        return { first, second };
      }),
    );
    expect(pages.second.items).toHaveLength(1);
    expect(pages.second.nextCursor).toBeUndefined();
    const ids = [...pages.first.items, ...pages.second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("the Edit Overlap methods", () => {
  it("opens an overlap Discussion as system, its subject naming the file", async () => {
    const { short, long, entries } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const resourceId = yield* insertResource("repo");
        const repository = "github.com/acme/web";
        return {
          short: yield* inTransaction(
            service.openOverlapDiscussion({
              resourceId,
              repository,
              path: "src/router.ts",
            }),
          ),
          long: yield* inTransaction(
            service.openOverlapDiscussion({
              resourceId,
              repository,
              path: `${"😀".repeat(200)}/router.ts`,
            }),
          ),
          entries: yield* readEventsOfKind("discussion.created"),
        };
      }),
    );
    expect(short).toMatchObject({ kind: "overlap", subject: "Edits overlap in `src/router.ts`" });
    const cut = /^Edits overlap in `(.*)`$/u.exec(long.subject)![1]!;
    expect(Array.from(cut)).toHaveLength(160);
    expect(cut.startsWith("...")).toBe(true);
    expect(cut.endsWith("/router.ts")).toBe(true);
    expect(entries.map((entry) => entry.actor)).toEqual(["system", "system"]);
  });

  it("shares a file, then adds only the sessions it does not list yet", async () => {
    const { first, again, read, sessionIds } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [a, b, c] = yield* insertSessions(3);
        const overlap = yield* inTransaction(
          service.openOverlapDiscussion({
            resourceId: yield* insertResource("repo"),
            repository: "github.com/acme/web",
            path: "src/router.ts",
          }),
        );
        yield* inTransaction(service.join(overlap.id, [a!, b!, c!]));
        return {
          first: yield* inTransaction(service.shareFile(overlap.id, "src/router.ts", [a!, b!])),
          again: yield* inTransaction(service.shareFile(overlap.id, "src/router.ts", [b!, c!])),
          read: yield* service.read(overlap.id),
          sessionIds: [a!, b!, c!],
        };
      }),
    );
    const [a, b, c] = sessionIds;
    expect(first).toEqual([a, b]);
    expect(again).toEqual([c]);
    expect(read.discussion.sharedFiles.map((file) => file.sessionIds)).toEqual([[a, b, c]]);
    expect(read.discussion.sharedFileCount).toBe(1);
  });

  it("lists only the sessions that take part when it shares a file", async () => {
    const { listed, read, sessionIds } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [a, b, outsider] = yield* insertSessions(3);
        const overlap = yield* inTransaction(
          service.openOverlapDiscussion({
            resourceId: yield* insertResource("repo"),
            repository: "github.com/acme/web",
            path: "src/router.ts",
          }),
        );
        yield* inTransaction(service.join(overlap.id, [a!, b!]));
        return {
          listed: yield* inTransaction(
            service.shareFile(overlap.id, "src/router.ts", [b!, outsider!, a!]),
          ),
          read: yield* service.read(overlap.id),
          sessionIds: [a!, b!],
        };
      }),
    );
    const [a, b] = sessionIds;
    expect(listed).toEqual([b, a]);
    expect(read.discussion.sharedFiles.map((file) => file.sessionIds)).toEqual([[b, a]]);
  });

  it("never shares a 501st file", async () => {
    const { refused, count } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [sessionId] = yield* insertSessions(1);
        const overlap = yield* inTransaction(
          service.openOverlapDiscussion({
            resourceId: yield* insertResource("repo"),
            repository: "github.com/acme/web",
            path: "file-0",
          }),
        );
        yield* inTransaction(service.join(overlap.id, [sessionId!]));
        for (let index = 0; index < MAX_SHARED_FILES; index++) {
          yield* inTransaction(
            service.shareFile(overlap.id, `file-${String(index)}`, [sessionId!]),
          );
        }
        return {
          refused: yield* inTransaction(
            service.shareFile(overlap.id, "one-too-many", [sessionId!]),
          ),
          count: (yield* service.read(overlap.id)).discussion.sharedFileCount,
        };
      }),
    );
    expect(refused).toEqual([]);
    expect(count).toBe(MAX_SHARED_FILES);
  });

  it("lists the open overlap Discussions of a repository that hold one of the sessions", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const repo = yield* insertResource("repo", "github.com/acme/one");
        const other = yield* insertResource("repo", "github.com/acme/two");
        const open = (resourceId: string, repository: string) =>
          inTransaction(service.openOverlapDiscussion({ resourceId, repository, path: "a.ts" }));
        const [mine, roomy, full, ofOtherRepo, ofStranger] = [
          yield* open(repo, "github.com/acme/one"),
          yield* open(repo, "github.com/acme/one"),
          yield* open(repo, "github.com/acme/one"),
          yield* open(other, "github.com/acme/two"),
          yield* open(repo, "github.com/acme/one"),
        ];
        const [a, b] = (yield* insertSessions(2)) as [string, string];
        const strangers = yield* insertSessions(MAX_PARTICIPANTS);
        yield* inTransaction(service.join(mine.id, [a]));
        yield* inTransaction(
          service.join(roomy.id, [b, ...strangers.slice(0, MAX_PARTICIPANTS - 2)]),
        );
        yield* inTransaction(
          service.join(full.id, [a, b, ...strangers.slice(0, MAX_PARTICIPANTS - 2)]),
        );
        yield* inTransaction(service.join(ofOtherRepo.id, [a]));
        yield* inTransaction(service.join(ofStranger.id, strangers.slice(0, 1)));
        const listed = yield* service.listOpenOverlapDiscussions(repo, [a, b]);
        return { listed, ids: [mine.id, roomy.id, full.id], a, b };
      }),
    );
    expect(value.listed.map((item) => [item.id, item.hasRoom, item.participantSessionIds])).toEqual(
      [
        [value.ids[0], true, [value.a]],
        [value.ids[1], true, [value.b]],
        [value.ids[2], false, [value.a, value.b]],
      ],
    );
  });

  it("writes a system Post, until the Discussion holds the most system Posts", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const overlap = yield* inTransaction(
          service.openOverlapDiscussion({
            resourceId: yield* insertResource("repo"),
            repository: "github.com/acme/web",
            path: "src/router.ts",
          }),
        );
        const post = yield* inTransaction(
          service.writeSystemPost(overlap.id, "Shared files: `src/router.ts`."),
        );
        yield* insertPosts(overlap.id, "system", MAX_SYSTEM_POSTS - 1);
        const capped = yield* inTransaction(service.writeSystemPost(overlap.id, "one more"));
        return { post, capped, posted: yield* readEventsOfKind("discussion.posted") };
      }),
    );
    const post = Option.getOrThrow(value.post);
    expect(post.actor).toBe("system");
    expect(Option.isNone(value.capped)).toBe(true);
    expect(value.posted.map((entry) => [entry.actor, entry.payload])).toEqual([
      ["system", { discussionId: post.discussionId, postId: post.id }],
    ]);
  });
});

describe("the changes a Discussion write announces", () => {
  it("announces the Discussion after create, post, join and shareFile", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const id = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [first, second] = yield* insertSessions(2);
        const opened = yield* openDiscussion();
        yield* service.post(opened, "Thanks.");
        yield* inTransaction(service.join(opened, [first!, second!]));
        yield* inTransaction(service.shareFile(opened, "src/router.ts", [second!]));
        return opened;
      }).pipe(Effect.provide(listener)),
    );
    const discussionChanges = announced.filter(
      (change) => change._tag === "record" && change.topic === "discussion",
    );
    expect(discussionChanges).toEqual(
      // The create announces its Discussion and its first Post.
      ["created", "updated", "updated", "updated", "updated"].map((kind) => ({
        _tag: "record",
        topic: "discussion",
        id,
        kind,
      })),
    );
  });
});

/** Writes a Post as the session, with the discussion grants. */
const postAs = (sessionId: string, discussionId: string, text: string) =>
  Effect.provideService(
    Effect.flatMap(DiscussionService, (service) => service.post(discussionId, text)),
    CurrentActor,
    buildSessionActor(sessionId),
  );

/** Opens a general Discussion as the session, about a new repo, and returns its id. */
const openDiscussionAs = (sessionId: string) =>
  Effect.provideService(openDiscussion(), CurrentActor, buildSessionActor(sessionId));

/** Drafts the session's Discussion Input. */
const draft = (sessionId: string) =>
  Effect.flatMap(DiscussionService, (service) => service.draftDiscussionInput(sessionId));

/**
 * Drafts the session's Discussion Input and marks what it tells as told, as
 * the controller daemon does once the runner takes it. Returns the draft.
 */
const tell = (sessionId: string) =>
  Effect.gen(function* () {
    const drafted = yield* draft(sessionId);
    if (Option.isSome(drafted)) {
      yield* Effect.flatMap(DiscussionService, (service) =>
        inTransaction(service.markTold(sessionId, drafted.value.told)),
      );
    }
    return drafted;
  });

/** Opens an overlap Discussion of a new repo, and returns its id. */
const openOverlap = (path = "src/router.ts") =>
  Effect.gen(function* () {
    const service = yield* DiscussionService;
    const overlap = yield* inTransaction(
      service.openOverlapDiscussion({
        resourceId: yield* insertResource("repo", `github.com/acme/${mintId()}`),
        repository: "github.com/acme/web",
        path,
      }),
    );
    return overlap.id;
  });

describe("drafting a Discussion Input", () => {
  it("tells an entry, marking each other session that cannot be told", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const sql = yield* SqlClient.SqlClient;
        const me = yield* insertToldableSession();
        const told = yield* insertToldableSession();
        const exited = yield* insertToldableSession();
        yield* withTransaction(
          sql,
          sql`UPDATE sessions SET status = 'exited' WHERE id = ${uuidFromString(exited)}`,
        );
        const id = yield* openOverlap();
        yield* inTransaction(service.join(id, [me, told, exited]));
        yield* inTransaction(service.shareFile(id, "src/router.ts", [told, me, exited]));
        const systemPost = Option.getOrThrow(
          yield* inTransaction(service.writeSystemPost(id, "Shared files: `src/router.ts`.")),
        );
        return { id, me, told, exited, systemPost, drafted: yield* draft(me) };
      }),
    );
    const drafted = Option.getOrThrow(value.drafted);
    expect(drafted.text).toContain(
      `- \`src/router.ts\`, with session ${toIdTail(value.told)}, session ${toIdTail(value.exited)} (not told)\n`,
    );
    // The system Post is newer than the join, but the entry already tells
    // the session to read the whole Discussion.
    expect(drafted.text).not.toContain("New posts");
    expect(drafted.holdsEntry).toBe(true);
    expect(drafted.told).toEqual({
      entryDiscussionIds: [value.id],
      toldThrough: [{ discussionId: value.id, postId: value.systemPost.id }],
    });
  });

  it("tells new Posts from the first another actor wrote, never the session's own", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [me, other] = yield* insertSessions(2);
        const id = yield* openDiscussionAs(me!);
        const fromOther = yield* postAs(other!, id, "I take the tests.");
        yield* postAs(me!, id, "Fine.");
        const fromUser = yield* service.post(id, "Thanks, both.");
        const onlyMine = yield* openDiscussionAs(me!);
        yield* postAs(me!, onlyMine, "Talking to myself.");
        return { id, fromOther, fromUser, drafted: yield* draft(me!) };
      }),
    );
    const drafted = Option.getOrThrow(value.drafted);
    expect(drafted.text).toBe(
      `New posts in discussion ${value.id}. ` +
        `Read them with \`hercule discussion read ${value.id} --from ${value.fromOther.id}\`.`,
    );
    expect(drafted.holdsEntry).toBe(false);
    expect(drafted.told).toEqual({
      entryDiscussionIds: [],
      toldThrough: [{ discussionId: value.id, postId: value.fromUser.id }],
    });
  });

  it("never tells a session about Posts written before it joined", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [byEdit, byPost] = yield* insertSessions(2);
        const id = yield* openDiscussion();
        yield* service.post(id, "Before anyone joined.");
        yield* inTransaction(service.join(id, [byEdit!]));
        const entry = yield* tell(byEdit!);
        const joining = yield* postAs(byPost!, id, "I join by posting.");
        return {
          joining,
          entry,
          afterEntry: yield* draft(byEdit!),
          afterPosting: yield* draft(byPost!),
        };
      }),
    );
    expect(Option.getOrThrow(value.entry).holdsEntry).toBe(true);
    // A session that joins by posting knows the Discussion: it gets no entry.
    expect(Option.isNone(value.afterPosting)).toBe(true);
    // Once the entry is told, only the Post written after it is new.
    expect(Option.getOrThrow(value.afterEntry).told.toldThrough).toEqual([
      { discussionId: value.joining.discussionId, postId: value.joining.id },
    ]);
    expect(Option.getOrThrow(value.afterEntry).text).toContain(`--from ${value.joining.id}`);
  });

  it("returns none when there is nothing to tell", async () => {
    const drafted = await run(
      Effect.gen(function* () {
        const [me] = yield* insertSessions(1);
        yield* openDiscussionAs(me!);
        return yield* draft(me!);
      }),
    );
    expect(Option.isNone(drafted)).toBe(true);
  });

  it("marks only the Discussions the text names, newest activity first, and tells the rest later", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [me] = yield* insertSessions(1);
        const ids: Array<string> = [];
        for (let index = 0; index < 12; index++) {
          const id = yield* openDiscussionAs(me!);
          yield* TestClock.adjust("1 second");
          yield* service.post(id, "A reply.");
          ids.push(id);
        }
        const first = Option.getOrThrow(yield* tell(me!));
        const second = Option.getOrThrow(yield* tell(me!));
        return { ids, first, second, third: yield* draft(me!) };
      }),
    );
    const newestFirst = value.ids.toReversed();
    expect(value.first.told.toldThrough.map((mark) => mark.discussionId)).toEqual(
      newestFirst.slice(0, 10),
    );
    expect(value.first.text).toContain("and 2 more discussions");
    expect(value.second.told.toldThrough.map((mark) => mark.discussionId)).toEqual(
      newestFirst.slice(10),
    );
    expect(Option.isNone(value.third)).toBe(true);
  });

  it("leaves the entries the text only counts pending, and tells them next", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [me, other] = yield* insertSessions(2);
        const ids: Array<string> = [];
        for (let index = 0; index < 6; index++) {
          const id = yield* openOverlap();
          yield* TestClock.adjust("1 second");
          yield* inTransaction(service.join(id, [me!, other!]));
          yield* inTransaction(service.shareFile(id, "src/router.ts", [me!, other!]));
          ids.push(id);
        }
        const first = Option.getOrThrow(yield* tell(me!));
        return { ids, first, second: Option.getOrThrow(yield* tell(me!)) };
      }),
    );
    expect(value.first.told.entryDiscussionIds).toEqual(value.ids.slice(0, 5));
    expect(value.first.text).toContain("and 1 more discussions");
    expect(value.second.told.entryDiscussionIds).toEqual(value.ids.slice(5));
  });
  it("says no one can be told only when no other session sharing a file can, named or not", async () => {
    const drafted = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const me = yield* insertToldableSession();
        // Five sessions without the discussion grants, which the text names,
        // then one that can be told, which it only counts.
        const others = [...(yield* insertSessions(5)), yield* insertToldableSession()];
        const id = yield* openOverlap();
        yield* inTransaction(service.join(id, [me, ...others]));
        yield* inTransaction(service.shareFile(id, "src/router.ts", [me, ...others]));
        return Option.getOrThrow(yield* draft(me));
      }),
    );
    expect(drafted.text.match(/\(not told\)/g)).toHaveLength(5);
    expect(drafted.text).toContain(", and 1 more session\n");
    expect(drafted.text).not.toContain("None of them can be told now.");
  });

  it("reads only the entries, files and new Posts the text can name, and counts the rest", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const discussions = yield* discussionRepository;
        const [me, other, stranger] = yield* insertSessions(3);
        const entryIds: Array<string> = [];
        for (let index = 0; index < 7; index++) {
          const id = yield* openOverlap();
          yield* TestClock.adjust("1 second");
          yield* inTransaction(service.join(id, [me!, other!]));
          entryIds.push(id);
        }
        const first = entryIds[0]!;
        // Nine files list the session and three do not; the stranger is on
        // those three only, so it shares no file with the session.
        for (let index = 0; index < 12; index++) {
          const sessions = index % 4 === 3 ? [other!, stranger!] : [me!, other!];
          yield* inTransaction(service.shareFile(first, `f${index}.ts`, sessions));
        }
        for (let index = 0; index < 12; index++) {
          const id = yield* openDiscussionAs(me!);
          yield* service.post(id, "A reply.");
        }
        return {
          me: me!,
          other: other!,
          entryIds,
          entries: yield* discussions.listPendingEntries(me!, 5),
          files: yield* discussions.listFilesSharedWith(first, me!, 5),
          sharing: yield* discussions.listSessionsSharingFilesWith(first, me!),
          untold: yield* discussions.listUntoldPosts(me!, 10),
          drafted: Option.getOrThrow(yield* draft(me!)),
        };
      }),
    );
    expect(value.entries.items.map((entry) => entry.discussionId)).toEqual(
      value.entryIds.slice(0, 5),
    );
    expect(value.entries.count).toBe(7);
    expect(value.files.items.map((file) => file.path)).toEqual([
      "f0.ts",
      "f1.ts",
      "f2.ts",
      "f4.ts",
      "f5.ts",
    ]);
    expect(value.files.count).toBe(9);
    expect(value.sharing).toEqual([value.other]);
    expect(value.untold.items).toHaveLength(10);
    expect(value.untold.count).toBe(12);
    expect(value.drafted.text).toContain(
      `and 4 more files; see \`hercule discussion read ${value.entryIds[0]}\``,
    );
    expect(value.drafted.text).toContain("and 2 more discussions: run");
    expect(value.drafted.text.match(/and 2 more discussions: run/g)).toHaveLength(2);
  });
});

describe("marking a Discussion Input told", () => {
  it("never moves a session's mark back to an older Post", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [me] = yield* insertSessions(1);
        const id = yield* openDiscussionAs(me!);
        yield* service.post(id, "older");
        const stale = Option.getOrThrow(yield* draft(me!)).told;
        yield* service.post(id, "newer");
        yield* tell(me!);
        yield* inTransaction(service.markTold(me!, stale));
        return { drafted: yield* draft(me!) };
      }),
    );
    expect(Option.isNone(value.drafted)).toBe(true);
  });

  it("leaves a Post written after the draft untold", async () => {
    const value = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [me] = yield* insertSessions(1);
        const id = yield* openDiscussionAs(me!);
        yield* service.post(id, "drafted");
        const drafted = Option.getOrThrow(yield* draft(me!));
        const late = yield* service.post(id, "after the draft");
        yield* inTransaction(service.markTold(me!, drafted.told));
        return { late, next: yield* draft(me!) };
      }),
    );
    expect(Option.getOrThrow(value.next).text).toContain(`--from ${value.late.id}`);
  });
});

describe("whether a session can receive a Discussion Input", () => {
  it("returns each reason in order, and undefined for a session that can", async () => {
    const refusals = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const sql = yield* SqlClient.SqlClient;
        const [running, exited, done, conversation] = yield* Effect.forEach(
          Array.from({ length: 4 }),
          () => insertToldableSession(),
        );
        const readOnly = yield* insertSession(null, yield* insertProfile(["discussion.read"]));
        // Each session also fails every later check, so only the first is returned.
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* sql`UPDATE sessions SET status = 'exited', done_at = ${AT}, done_by = 'user'
                       WHERE id = ${uuidFromString(exited!)}`;
            yield* sql`UPDATE sessions SET done_at = ${AT}, done_by = 'user', conversation_id = ${mintUuid()}
                       WHERE id = ${uuidFromString(done!)}`;
            yield* sql`UPDATE sessions SET conversation_id = ${mintUuid()}
                       WHERE id = ${uuidFromString(conversation!)}`;
          }),
        );
        return yield* Effect.forEach(
          [running!, exited!, done!, conversation!, readOnly, yield* insertSession()],
          (id) => service.findDiscussionInputRefusal(id),
        );
      }),
    );
    expect(refusals).toEqual([
      undefined,
      "not_running",
      "done",
      "conversation",
      "lacks_grants",
      "lacks_grants",
    ]);
  });
});
