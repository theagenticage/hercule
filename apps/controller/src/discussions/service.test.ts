import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MAX_DISCUSSION_POSTS,
  MAX_PARTICIPANTS,
  MAX_SHARED_FILES,
  MAX_SYSTEM_POSTS,
  type Grant,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { SessionService, sessionRepository } from "../sessions";
import type { DiscussionMentions } from "../sessions/discussion-input";
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

/** One call of `SessionService.mentionDiscussions`, as the stub records it. */
interface Mention {
  readonly sessionId: string;
  readonly mentions: DiscussionMentions;
}

type Deps = DiscussionService | SqlClient.SqlClient;

/**
 * Runs an effect as `actor` against a fresh database, with a session service
 * that only records the Discussion mentions it is asked to write. Returns the
 * effect's value and those mentions.
 */
const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) => {
  const mentioned: Array<Mention> = [];
  const sessions = Layer.succeed(SessionService, {
    mentionDiscussions: (sessionId: string, mentions: DiscussionMentions) =>
      Effect.sync(() => {
        mentioned.push({ sessionId, mentions });
        return undefined;
      }),
  } as unknown as SessionService["Service"]);
  const layer = DiscussionServiceLayer.pipe(
    Layer.provide(sessions),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );
  return Effect.runPromise(
    Effect.provideService(effect, CurrentActor, actor).pipe(
      Effect.map((value) => ({ value, mentioned })),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );
};

const run = async <A, E>(effect: Effect.Effect<A, E, Deps>) => (await runAs(USER, effect)).value;

/** Runs a call that is expected to fail as `actor`, and returns its error. */
const runErrorAs = async <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) =>
  (await runAs(actor, Effect.flip(effect))).value;

/** Inserts a session row, which a participant must point at, and returns its id. */
const insertSession = (workspaceId: string | null = null) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const id = mintId();
    yield* sessions.insert({
      id,
      title: "a session",
      permissionProfileId: mintId(),
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
    });
    return id;
  });

/** Inserts `count` sessions and returns their ids. */
const insertSessions = (count: number) =>
  Effect.forEach(Array.from({ length: count }), () => insertSession());

/** Inserts a Resource of `kind` and returns its id. */
const insertResource = (kind: "repo" | "folder", canonicalRemote = "github.com/acme/web") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintId();
    yield* sql`
      INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
      VALUES (${uuidFromString(id)}, ${kind},
              ${kind === "repo" ? `https://${canonicalRemote}` : null},
              ${kind === "repo" ? canonicalRemote : null}, ${kind === "repo" ? 1 : 0}, ${AT}, ${AT})
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
        INSERT INTO checkouts (id, workspace_id, resource_id, form, branches, position, created_at)
        VALUES (${mintUuid()}, ${workspace}, ${uuidFromString(resourceId)}, 'clone', '[]',
                ${position}, ${AT})
      `,
    );
    return uuidToString(workspace);
  });

/** Writes `count` Posts straight into the table, as `actor`, faster than posting each. */
const insertPosts = (discussionId: string, actor: string, count: number) =>
  Effect.gen(function* () {
    const discussions = yield* discussionRepository;
    for (let index = 0; index < count; index++) {
      yield* discussions.insertPost({
        id: mintId(),
        discussionId,
        actor,
        text: "a post",
        createdAt: AT,
      });
    }
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
    const { value, mentioned } = await runAs(
      USER,
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
    expect(mentioned).toEqual([]);
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
  it("makes the poster a participant and tells every other participant", async () => {
    const { value, mentioned } = await runAs(
      USER,
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
    const { first, second, id, post, fromUser, read } = value;
    expect(post.actor).toBe(`session:${second}`);
    expect(read.discussion).toMatchObject({
      postCount: 3,
      participantSessionIds: [first, second],
      lastPostAt: fromUser.createdAt,
    });
    expect(mentioned).toEqual([
      {
        sessionId: first,
        mentions: { entries: [], newPosts: [{ discussionId: id, firstPostId: post.id }] },
      },
      {
        sessionId: first,
        mentions: { entries: [], newPosts: [{ discussionId: id, firstPostId: fromUser.id }] },
      },
      {
        sessionId: second,
        mentions: { entries: [], newPosts: [{ discussionId: id, firstPostId: fromUser.id }] },
      },
    ]);
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
          systemPost: yield* service.writeSystemPost(id, "Shared files: `a.ts`.", []),
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
    const { value, mentioned } = await runAs(
      USER,
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const id = yield* openDiscussion();
        const sessionIds = yield* insertSessions(MAX_PARTICIPANTS + 1);
        const joined = yield* service.join(id, sessionIds);
        const late = sessionIds[MAX_PARTICIPANTS]!;
        const post = yield* Effect.provideService(
          service.post(id, "May I join?"),
          CurrentActor,
          buildSessionActor(late),
        );
        return { joined, post, late, read: yield* service.read(id) };
      }),
    );
    expect(value.joined).toHaveLength(MAX_PARTICIPANTS);
    expect(value.post.actor).toBe(`session:${value.late}`);
    expect(value.read.discussion.participantCount).toBe(MAX_PARTICIPANTS);
    expect(value.read.discussion.participantSessionIds).not.toContain(value.late);
    expect(mentioned).toHaveLength(MAX_PARTICIPANTS);
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
        const overlap = yield* service.openOverlapDiscussion({
          resourceId: api,
          repository: "github.com/acme/api",
          path: "src/router.ts",
        });
        yield* service.join(overlap.id, [sessionId!]);
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
        yield* sql`DELETE FROM resources WHERE id = ${uuidFromString(web)}`;
        return {
          id,
          filtered: yield* service.query({ resourceId: web }),
          unfiltered: yield* service.query({}),
          read: yield* service.read(id),
        };
      }),
    );
    expect(result.filtered.items).toEqual([]);
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
          short: yield* service.openOverlapDiscussion({
            resourceId,
            repository,
            path: "src/router.ts",
          }),
          long: yield* service.openOverlapDiscussion({
            resourceId,
            repository,
            path: `${"😀".repeat(200)}/router.ts`,
          }),
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
        const overlap = yield* service.openOverlapDiscussion({
          resourceId: yield* insertResource("repo"),
          repository: "github.com/acme/web",
          path: "src/router.ts",
        });
        return {
          first: yield* service.shareFile(overlap.id, "src/router.ts", [a!, b!]),
          again: yield* service.shareFile(overlap.id, "src/router.ts", [b!, c!]),
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

  it("never shares a 501st file", async () => {
    const { refused, count } = await run(
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [sessionId] = yield* insertSessions(1);
        const overlap = yield* service.openOverlapDiscussion({
          resourceId: yield* insertResource("repo"),
          repository: "github.com/acme/web",
          path: "file-0",
        });
        for (let index = 0; index < MAX_SHARED_FILES; index++) {
          yield* service.shareFile(overlap.id, `file-${String(index)}`, [sessionId!]);
        }
        return {
          refused: yield* service.shareFile(overlap.id, "one-too-many", [sessionId!]),
          count: (yield* service.read(overlap.id)).discussion.sharedFileCount,
        };
      }),
    );
    expect(refused).toEqual([]);
    expect(count).toBe(MAX_SHARED_FILES);
  });

  it("writes a system Post to every participant but the excepted sessions, until the system cap", async () => {
    const { value, mentioned } = await runAs(
      USER,
      Effect.gen(function* () {
        const service = yield* DiscussionService;
        const [mentioned, excepted] = yield* insertSessions(2);
        const overlap = yield* service.openOverlapDiscussion({
          resourceId: yield* insertResource("repo"),
          repository: "github.com/acme/web",
          path: "src/router.ts",
        });
        yield* service.join(overlap.id, [mentioned!, excepted!]);
        const post = yield* service.writeSystemPost(overlap.id, "Shared files: `src/router.ts`.", [
          excepted!,
        ]);
        yield* insertPosts(overlap.id, "system", MAX_SYSTEM_POSTS - 1);
        const capped = yield* service.writeSystemPost(overlap.id, "one more", []);
        return { mentioned, post, capped, posted: yield* readEventsOfKind("discussion.posted") };
      }),
    );
    const post = Option.getOrThrow(value.post);
    expect(post.actor).toBe("system");
    expect(Option.isNone(value.capped)).toBe(true);
    expect(mentioned).toEqual([
      {
        sessionId: value.mentioned,
        mentions: {
          entries: [],
          newPosts: [{ discussionId: post.discussionId, firstPostId: post.id }],
        },
      },
    ]);
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
        yield* service.join(opened, [first!]);
        yield* service.shareFile(opened, "src/router.ts", [second!]);
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
