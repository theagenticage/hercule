/**
 * Tests how a Task's branch finds its pull request, on real rows and the real
 * Task service, through the Entity Observations port that plugins report
 * through and through `BranchLinks`:
 *
 * - the link step: both orders of branch and pull request, a rename, the
 *   workspaces and branches that never link, the Tasks that share a branch, a
 *   fork, a pull request that was merged before it was first seen, and an
 *   unlink that holds;
 * - the branches a plugin is asked to look up, their rotation and the Tasks
 *   that already have their pull request;
 * - the plan of the match, which must use the index on the head.
 */
import { describe, expect, it } from "vitest";
import { Context, Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { EntityObservation, QualifiedEntityKindDeclaration } from "@hercule/plugin-host";
import { CurrentActor } from "../../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../../db";
import { EntityObservations, type EntityReporter } from "../../plugins";
import { TaskService } from "../../tasks";
import {
  A_MINUTE,
  arrangeConnection,
  CONNECTION,
  createTaskLinking,
  declareKinds,
  PLUGIN,
  PULL_REQUEST,
  PULL_REQUEST_PREFIX,
  pr,
  readFacts,
  TaskTestLayer,
  USER,
} from "../../tasks/testing";
import { EntityObservationsLayer } from "../ingest";
import { buildBranchMatch, BranchLinks, BranchLinksLayer } from "./branch-links";

const REMOTE = "github.com/northwind/web";
const FORK_REMOTE = "github.com/octo-fork/web";
const AT = "2026-11-01T00:00:00.000Z";

const PULL_REQUEST_KIND: QualifiedEntityKindDeclaration = {
  word: PULL_REQUEST,
  noun: "Pull request",
  refPrefix: PULL_REQUEST_PREFIX,
  pace: "fast",
  patience: 24,
  identifier: "#{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
};

const reporter: EntityReporter = {
  connectionId: CONNECTION,
  pluginId: PLUGIN,
  kinds: [PULL_REQUEST_KIND],
};

const layer = Layer.mergeAll(EntityObservationsLayer, BranchLinksLayer).pipe(
  Layer.provideMerge(TaskTestLayer),
);

/** Runs `body` on a fresh database that holds the northwind plugin, its kinds and a Connection. */
const run = <A>(
  body: Effect.Effect<
    A,
    unknown,
    EntityObservations | BranchLinks | TaskService | SqlClient.SqlClient
  >,
  logged: Array<string> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00Z"));
      yield* arrangeConnection;
      yield* declareKinds;
      return yield* body;
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>(({ message }) => {
            logged.push(String(message));
          }),
        ]),
      ),
      Effect.provide(TestClock.layer()),
      Effect.orDie,
    ),
  );

/** Builds the observation of pull request `number`, whose head is `head` (a branch of `REMOTE` unless a remote is given). */
const pullRequest = (
  number: number,
  head: { readonly branch: string; readonly remote?: string } | undefined,
  lifecycle: "open" | "completed" | "abandoned" = "open",
  createdAt: string | null = AT,
  sourceUpdatedAt = AT,
): EntityObservation => ({
  kind: "pull-request",
  ref: pr(number),
  title: `Pull request ${String(number)}`,
  url: `https://northwind.example/pull/${String(number)}`,
  lifecycle,
  fields: { key: String(number) },
  concerns: ["assigned"],
  ...(createdAt === null ? {} : { sourceCreatedAt: createdAt }),
  sourceUpdatedAt,
  repository: {
    target: { remote: REMOTE },
    ...(head === undefined ? {} : { head: { remote: head.remote ?? REMOTE, branch: head.branch } }),
  },
});

/** Reports pull requests as a complete scan, a minute after the last call. */
const scan = (...observations: ReadonlyArray<EntityObservation>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const observed = yield* EntityObservations;
    yield* observed.reconcile(reporter, { kind: "pull-request", complete: true, observations });
  });

/** Reports pull requests as a refresh does, a minute after the last call. */
const refresh = (...observations: ReadonlyArray<EntityObservation>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const observed = yield* EntityObservations;
    yield* observed.refresh(reporter, observations);
  });

/** What `arrangeBranch` is given. */
interface ArrangedBranch {
  /** The branch the checkout is on, or null for none. */
  readonly branch: string | null;
  readonly remote?: string;
  readonly defaultBranch?: string | null;
  readonly workspaceKind?: "ephemeral" | "primary";
  readonly remoteBranches?: ReadonlyArray<string>;
  /** When the workspace was created. */
  readonly createdAt?: string;
  /** The Tasks that have a session in the workspace: one session for each. */
  readonly taskIds: ReadonlyArray<string>;
}

/** Writes a workspace with one checkout and a session for each Task, and returns the checkout's id. */
const arrangeBranch = (arranged: ArrangedBranch) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const remote = arranged.remote ?? REMOTE;
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly id: Uint8Array }>`
          SELECT id FROM resources WHERE canonical_remote = ${remote}`;
        const resource = existing[0]?.id ?? mintUuid();
        if (existing.length === 0) {
          yield* sql`INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include,
                                            created_at, updated_at)
                     VALUES (${resource}, 'repo', ${`https://${remote}`}, ${remote}, 1, ${AT}, ${AT})`;
        }
        const runner = mintUuid();
        const workspace = mintUuid();
        const checkout = mintUuid();
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                                        credential_hash, created_at, updated_at)
                   VALUES (${runner}, ${uuidToString(runner)}, 'online', 'active', 0, '[]',
                           ${uuidToString(runner)}, ${AT}, ${AT})`;
        yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at)
                   VALUES (${workspace}, ${runner}, ${arranged.workspaceKind ?? "ephemeral"}, 'ready', ${arranged.createdAt ?? AT})`;
        yield* sql`INSERT INTO checkouts (id, workspace_id, resource_id, form, branch, branches,
                                          default_branch, remote_branches, position, created_at)
                   VALUES (${checkout}, ${workspace}, ${resource}, 'clone', ${arranged.branch}, '[]',
                           ${arranged.defaultBranch === undefined ? "main" : arranged.defaultBranch},
                           ${JSON.stringify(arranged.remoteBranches ?? [])}, 0, ${AT})`;
        for (const taskId of arranged.taskIds) {
          yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                           requested_access_mode, access_mode, spec, title, status,
                                           created_at, last_activity_at, task_id, workspace_id)
                     VALUES (${mintUuid()}, ${mintUuid()}, ${mintUuid()}, ${runner}, 'default', 'default',
                             '{}', 'thread', 'idle', ${AT}, ${AT}, ${uuidFromString(taskId)},
                             ${workspace})`;
        }
        return uuidToString(checkout);
      }),
    );
  });

/** Moves a checkout to another branch, as a runner's report of the workspace does. */
const moveCheckout = (checkoutId: string, branch: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      sql`UPDATE checkouts SET branch = ${branch} WHERE id = ${uuidFromString(checkoutId)}`,
    );
  });

/** Creates a Task that links nothing. */
const createTask = (title: string) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks.create({ title, description: "" });
  });

/** Returns the refs a Task links, each with who linked it. */
const readLinks = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly ref: string; readonly linked_by: string }>`
      SELECT ref, linked_by FROM task_entity_links
      WHERE task_id = ${uuidFromString(taskId)} ORDER BY ref`;
    return rows.map((row) => ({ ref: row.ref, linkedBy: row.linked_by }));
  });

/** Returns the refs a Task links. */
const readLinkedRefs = (taskId: string) =>
  Effect.map(readLinks(taskId), (links) => links.map((link) => link.ref));

describe("linking a pull request to the Task whose branch it comes from", () => {
  it("links a pull request that is scanned after the branch exists, stamped as the system", async () => {
    const { links, facts } = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        return { links: yield* readLinks(task.id), facts: yield* readFacts };
      }),
    );
    expect(links).toEqual([{ ref: pr(1), linkedBy: "system" }]);
    expect(facts).toMatchObject([{ ref: pr(1), lifecycle: "open", previousLifecycle: null }]);
  });

  it("links a pull request that is stored first, once the checkout reports the branch", async () => {
    const { before, after } = await run(
      Effect.gen(function* () {
        const links = yield* BranchLinks;
        const task = yield* createTask("Fix login");
        const checkout = yield* arrangeBranch({ branch: "hercule/thread-1", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        const before = yield* readLinkedRefs(task.id);
        yield* moveCheckout(checkout, "fix-login");
        yield* links.linkEntitiesByBranch();
        return { before, after: yield* readLinkedRefs(task.id) };
      }),
    );
    expect(before).toEqual([]);
    expect(after).toEqual([pr(1)]);
  });

  it("follows a branch the agent renamed", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const links = yield* BranchLinks;
        const task = yield* createTask("Fix login");
        const checkout = yield* arrangeBranch({ branch: "old-name", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "old-name" }));
        const linked = yield* readLinkedRefs(task.id);
        yield* scan(pullRequest(1, { branch: "old-name" }), pullRequest(2, { branch: "new-name" }));
        yield* moveCheckout(checkout, "new-name");
        yield* links.linkEntitiesByBranch();
        return { linked, now: yield* readLinkedRefs(task.id) };
      }),
    );
    expect(refs.linked).toEqual([pr(1)]);
    expect(refs.now).toEqual([pr(1), pr(2)]);
  });

  it("never links through a main workspace", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", workspaceKind: "primary", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        return yield* readLinkedRefs(task.id);
      }),
    );
    expect(refs).toEqual([]);
  });

  it("never links through a checkout on its default branch, or on no branch", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const onDefault = yield* createTask("On the default branch");
        const detached = yield* createTask("Detached");
        yield* arrangeBranch({ branch: "main", defaultBranch: "main", taskIds: [onDefault.id] });
        yield* arrangeBranch({ branch: null, taskIds: [detached.id] });
        yield* scan(pullRequest(1, { branch: "main" }));
        return [yield* readLinkedRefs(onDefault.id), yield* readLinkedRefs(detached.id)];
      }),
    );
    expect(refs).toEqual([[], []]);
  });

  it("links a checkout whose default branch is unknown", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", defaultBranch: null, taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        return yield* readLinkedRefs(task.id);
      }),
    );
    expect(refs).toEqual([pr(1)]);
  });

  it("links one Task that has several sessions on the branch, once", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id, task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        return yield* readLinks(task.id);
      }),
    );
    expect(refs).toEqual([{ ref: pr(1), linkedBy: "system" }]);
  });

  it("links neither Task when two live Tasks work on one branch, and says so once", async () => {
    const logged: Array<string> = [];
    const refs = await run(
      Effect.gen(function* () {
        const first = yield* createTask("First");
        const second = yield* createTask("Second");
        yield* arrangeBranch({ branch: "shared", taskIds: [first.id] });
        yield* arrangeBranch({ branch: "shared", taskIds: [second.id] });
        yield* scan(pullRequest(1, { branch: "shared" }));
        yield* scan(pullRequest(1, { branch: "shared" }));
        return [yield* readLinkedRefs(first.id), yield* readLinkedRefs(second.id)];
      }),
      logged,
    );
    expect(refs).toEqual([[], []]);
    const shared = logged.filter((line) => line.includes("shared"));
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain("2 live Tasks");
    expect(shared[0]).toContain(REMOTE);
  });

  it("counts a Task that unlinked the pull request, so the other Task is not given it", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const first = yield* createTask("First");
        const second = yield* createTask("Second");
        yield* arrangeBranch({ branch: "shared", taskIds: [first.id] });
        yield* scan(pullRequest(1, { branch: "shared" }));
        // The first Task is alone on the branch, so it has the pull request.
        const alone = yield* readLinkedRefs(first.id);
        yield* tasks.unlinkEntity({ id: first.id, ref: pr(1) });
        yield* arrangeBranch({ branch: "shared", taskIds: [second.id] });
        yield* scan(pullRequest(1, { branch: "shared" }));
        return {
          alone,
          first: yield* readLinkedRefs(first.id),
          second: yield* readLinkedRefs(second.id),
        };
      }),
    );
    expect(refs).toEqual({ alone: [pr(1)], first: [], second: [] });
  });

  it("links the Task again once the other Task is finished", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const first = yield* createTask("First");
        const second = yield* createTask("Second");
        yield* arrangeBranch({ branch: "shared", taskIds: [first.id] });
        yield* arrangeBranch({ branch: "shared", taskIds: [second.id] });
        yield* scan(pullRequest(1, { branch: "shared" }));
        yield* tasks.update({ id: second.id, stage: "dropped" });
        yield* scan(pullRequest(1, { branch: "shared" }));
        return [yield* readLinkedRefs(first.id), yield* readLinkedRefs(second.id)];
      }),
    );
    expect(refs).toEqual([[pr(1)], []]);
  });

  it("does not match a fork's pull request to the repository it targets", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login", remote: FORK_REMOTE }));
        return yield* readLinkedRefs(task.id);
      }),
    );
    expect(refs).toEqual([]);
  });

  it("never matches two repositories that share a branch name to each other", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const inRepository = yield* createTask("In the repository");
        const inOtherRepository = yield* createTask("In the other repository");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [inRepository.id] });
        yield* arrangeBranch({
          branch: "fix-login",
          remote: FORK_REMOTE,
          taskIds: [inOtherRepository.id],
        });
        yield* scan(pullRequest(1, { branch: "fix-login", remote: FORK_REMOTE }));
        return [
          yield* readLinkedRefs(inRepository.id),
          yield* readLinkedRefs(inOtherRepository.id),
        ];
      }),
    );
    expect(refs).toEqual([[], [pr(1)]]);
  });

  it("does not match a pull request with no head", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* scan(pullRequest(1, undefined));
        return yield* readLinkedRefs(task.id);
      }),
    );
    expect(refs).toEqual([]);
  });

  it("links a pull request that was already merged when it was first seen, with a fact that lands the card", async () => {
    const { refs, facts } = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* refresh(pullRequest(1, { branch: "fix-login" }, "completed"));
        return { refs: yield* readLinkedRefs(task.id), facts: yield* readFacts };
      }),
    );
    expect(refs).toEqual([pr(1)]);
    expect(facts).toMatchObject([{ ref: pr(1), lifecycle: "completed", previousLifecycle: null }]);
  });

  it("does not link an old merged or closed pull request on a branch name that was reused, even when it was changed since", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix a typo again");
        yield* arrangeBranch({
          branch: "fix-typo",
          createdAt: "2026-11-01T00:00:00.000Z",
          taskIds: [task.id],
        });
        // Both were made before the workspace. The merged one was retitled and
        // the closed one was commented on after it, so their last change is new.
        yield* refresh(
          pullRequest(
            1,
            { branch: "fix-typo" },
            "completed",
            "2026-09-01T00:00:00.000Z",
            "2026-11-02T00:00:00.000Z",
          ),
          pullRequest(
            2,
            { branch: "fix-typo" },
            "abandoned",
            "2026-10-15T00:00:00.000Z",
            "2026-11-03T00:00:00.000Z",
          ),
        );
        return yield* readLinkedRefs(task.id);
      }),
    );
    expect(refs).toEqual([]);
  });

  it("links an open pull request however old, and one made after the workspace and merged", async () => {
    const { refs, facts } = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix a typo again");
        yield* arrangeBranch({
          branch: "fix-typo",
          createdAt: "2026-11-01T00:00:00.000Z",
          taskIds: [task.id],
        });
        yield* refresh(
          pullRequest(1, { branch: "fix-typo" }, "open", "2026-09-01T00:00:00.000Z"),
          pullRequest(
            2,
            { branch: "fix-typo" },
            "completed",
            "2026-11-01T06:00:00.000Z",
            "2026-11-02T00:00:00.000Z",
          ),
        );
        return { refs: yield* readLinkedRefs(task.id), facts: yield* readFacts };
      }),
    );
    expect(refs).toEqual([pr(1), pr(2)]);
    expect(facts).toMatchObject([
      { ref: pr(1), lifecycle: "open", previousLifecycle: null },
      { ref: pr(2), lifecycle: "completed", previousLifecycle: null },
    ]);
  });

  it("does not link a merged pull request whose creation time is not known", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* refresh(pullRequest(1, { branch: "fix-login" }, "completed", null));
        return yield* readLinkedRefs(task.id);
      }),
    );
    expect(refs).toEqual([]);
  });

  it("finds a pull request that was opened and merged between two scans, through its branch", async () => {
    const { asked, refs, facts } = await run(
      Effect.gen(function* () {
        const observed = yield* EntityObservations;
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({
          branch: "fix-login",
          remoteBranches: ["fix-login"],
          taskIds: [task.id],
        });
        // The scan lists open pull requests only, and this one never was in it.
        yield* scan();
        const asked = yield* observed.listTrackedBranches(reporter, "github.com/", 50);
        yield* refresh(
          pullRequest(
            7,
            { branch: "fix-login" },
            "completed",
            "2026-11-01T06:00:00.000Z",
            "2026-11-01T12:00:00.000Z",
          ),
        );
        return {
          asked,
          refs: yield* readLinkedRefs(task.id),
          facts: yield* readFacts,
        };
      }),
    );
    expect(asked).toEqual([{ remote: REMOTE, branch: "fix-login" }]);
    expect(refs).toEqual([pr(7)]);
    expect(facts).toMatchObject([{ lifecycle: "completed", previousLifecycle: null }]);
  });

  it("still finds its new pull request for a Task that came from a ticket", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const task = yield* createTaskLinking("From a ticket", "northwind:ticket:NW-12");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        return yield* readLinks(task.id);
      }),
    );
    expect(refs).toEqual([
      { ref: pr(1), linkedBy: "system" },
      { ref: "northwind:ticket:NW-12", linkedBy: "user" },
    ]);
  });

  it("does not link a Task that is finished or deleted", async () => {
    const refs = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const finished = yield* createTask("Finished");
        const deleted = yield* createTask("Deleted");
        yield* arrangeBranch({ branch: "one", taskIds: [finished.id] });
        yield* arrangeBranch({ branch: "two", taskIds: [deleted.id] });
        yield* tasks.update({ id: finished.id, stage: "done" });
        yield* tasks.delete(deleted.id);
        yield* scan(pullRequest(1, { branch: "one" }), pullRequest(2, { branch: "two" }));
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT * FROM task_entity_links`;
      }),
    );
    expect(refs).toEqual([]);
  });

  it("keeps a pull request the user unlinked away across scans and refreshes, and a link by hand brings it back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const links = yield* BranchLinks;
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        yield* refresh(pullRequest(1, { branch: "fix-login" }, "completed"));
        const linkedAgain = yield* links.linkEntitiesByBranch();
        const afterUnlink = yield* readLinkedRefs(task.id);
        yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        const sql = yield* SqlClient.SqlClient;
        const suppressions = yield* sql`SELECT * FROM task_entity_link_suppressions`;
        return {
          linkedAgain,
          afterUnlink,
          afterRelink: yield* readLinkedRefs(task.id),
          suppressions,
        };
      }),
    );
    expect(result).toEqual({
      linkedAgain: [],
      afterUnlink: [],
      afterRelink: [pr(1)],
      suppressions: [],
    });
  });

  it("reads the match and writes the links in one transaction, so no write lands between them", async () => {
    const { seenWhileLinking, branchAfter, refs } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        const task = yield* createTask("Fix login");
        const checkout = yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        yield* withTransaction(sql, sql`DELETE FROM task_entity_links`);
        let seenWhileLinking: string | undefined;
        let competitor: Promise<unknown> | undefined;
        // A task service that, just before it writes, lets another writer try to
        // move the checkout, waits, and looks at the branch.
        const racing = {
          ...tasks,
          linkMatchedEntities: (pairs: Parameters<typeof tasks.linkMatchedEntities>[0]) =>
            Effect.gen(function* () {
              // A fresh fiber tree has no ambient transaction, as another request has none.
              competitor = Effect.runPromise(
                withTransaction(
                  sql,
                  sql`UPDATE checkouts SET branch = 'elsewhere' WHERE id = ${uuidFromString(checkout)}`,
                ),
              );
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
              const rows = yield* sql<{ readonly branch: string }>`
                SELECT branch FROM checkouts WHERE id = ${uuidFromString(checkout)}`;
              seenWhileLinking = rows[0]!.branch;
              return yield* tasks.linkMatchedEntities(pairs);
            }),
        };
        const links = yield* Effect.scoped(
          Effect.map(Layer.build(Layer.fresh(BranchLinksLayer)), (context) =>
            Context.get(context, BranchLinks),
          ),
        ).pipe(Effect.provideService(TaskService, racing));
        const linkedNow = yield* links.linkEntitiesByBranch();
        if (competitor === undefined) throw new Error(`no race: ${JSON.stringify(linkedNow)}`);
        yield* Effect.promise(() => competitor!);
        const after = yield* sql<{ readonly branch: string }>`
          SELECT branch FROM checkouts WHERE id = ${uuidFromString(checkout)}`;
        return {
          seenWhileLinking,
          branchAfter: after[0]!.branch,
          refs: yield* readLinkedRefs(task.id),
        };
      }),
    );
    expect(seenWhileLinking).toBe("fix-login");
    expect(branchAfter).toBe("elsewhere");
    expect(refs).toEqual([pr(1)]);
  });

  it("writes nothing when nothing matches, and nothing the second time", async () => {
    const result = await run(
      Effect.gen(function* () {
        const links = yield* BranchLinks;
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "fix-login", taskIds: [task.id] });
        const none = yield* links.linkEntitiesByBranch();
        yield* scan(pullRequest(1, { branch: "fix-login" }));
        const again = yield* links.linkEntitiesByBranch();
        return { none, again };
      }),
    );
    expect(result).toEqual({ none: [], again: [] });
  });
});

/** Asks for the branches of the Connection, as a plugin does. */
const askTracked = (limit = 50, remotePrefix = "github.com/") =>
  Effect.flatMap(EntityObservations, (observed) =>
    observed.listTrackedBranches(reporter, remotePrefix, limit),
  );

describe("the branches a plugin is asked to look up", () => {
  it("lists a branch that is on the remote and not the default branch, once for any number of Tasks", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const first = yield* createTask("First");
        const second = yield* createTask("Second");
        yield* arrangeBranch({ branch: "shared", remoteBranches: ["shared"], taskIds: [first.id] });
        yield* arrangeBranch({
          branch: "shared",
          remoteBranches: ["shared"],
          taskIds: [second.id],
        });
        return yield* askTracked();
      }),
    );
    expect(asked).toEqual([{ remote: REMOTE, branch: "shared" }]);
  });

  it("leaves out what the Task could not have a pull request on", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Fix login");
        const finished = yield* createTask("Finished");
        yield* arrangeBranch({ branch: "listed", remoteBranches: ["listed"], taskIds: [task.id] });
        yield* arrangeBranch({
          branch: "local-only",
          remoteBranches: ["other"],
          taskIds: [task.id],
        });
        yield* arrangeBranch({
          branch: "in-main-workspace",
          workspaceKind: "primary",
          remoteBranches: ["in-main-workspace"],
          taskIds: [task.id],
        });
        yield* arrangeBranch({ branch: "main", remoteBranches: ["main"], taskIds: [task.id] });
        yield* arrangeBranch({
          branch: "elsewhere",
          remote: "gitlab.com/northwind/web",
          remoteBranches: ["elsewhere"],
          taskIds: [task.id],
        });
        yield* arrangeBranch({ branch: "done", remoteBranches: ["done"], taskIds: [finished.id] });
        yield* tasks.update({ id: finished.id, stage: "done" });
        return yield* askTracked();
      }),
    );
    expect(asked).toEqual([{ remote: REMOTE, branch: "listed" }]);
  });

  it("hides a branch only from a Task that links a pull request with that head", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        // A link to something else, such as its ticket: the branch is listed.
        const withTicket = yield* createTaskLinking("Has a ticket", "northwind:ticket:NW-1");
        // A link to a pull request with this head: nothing to look up.
        const withPullRequest = yield* createTask("Has its pull request");
        // A pull request with this head that the user unlinked: listed again.
        const unlinked = yield* createTask("Unlinked it");
        for (const [task, branch] of [
          [withTicket, "ticket-branch"],
          [withPullRequest, "pr-branch"],
          [unlinked, "unlinked-branch"],
        ] as const) {
          yield* arrangeBranch({ branch, remoteBranches: [branch], taskIds: [task.id] });
        }
        yield* scan(
          pullRequest(2, { branch: "pr-branch" }),
          pullRequest(3, { branch: "unlinked-branch" }),
        );
        yield* tasks.unlinkEntity({ id: unlinked.id, ref: pr(3) });
        return yield* askTracked();
      }),
    );
    expect(asked).toEqual([
      { remote: REMOTE, branch: "ticket-branch" },
      { remote: REMOTE, branch: "unlinked-branch" },
    ]);
  });

  it("lists a branch while another Task on it still has no pull request", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const first = yield* createTask("First");
        const second = yield* createTask("Second");
        yield* arrangeBranch({ branch: "b", remoteBranches: ["b"], taskIds: [first.id] });
        yield* scan(pullRequest(1, { branch: "b" }));
        yield* arrangeBranch({ branch: "b", remoteBranches: ["b"], taskIds: [second.id] });
        return yield* askTracked();
      }),
    );
    expect(asked).toEqual([{ remote: REMOTE, branch: "b" }]);
  });

  it("rotates through more branches than the limit, never-tried first and then the oldest", async () => {
    const rounds = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Many branches");
        for (const branch of ["a", "b", "c", "d", "e"]) {
          yield* arrangeBranch({ branch, remoteBranches: [branch], taskIds: [task.id] });
        }
        const rounds: Array<ReadonlyArray<string>> = [];
        for (let round = 0; round < 4; round++) {
          yield* TestClock.adjust(A_MINUTE);
          rounds.push((yield* askTracked(2)).map(({ branch }) => branch));
        }
        return rounds;
      }),
    );
    expect(rounds).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "a"],
      ["b", "c"],
    ]);
  });

  it("asks for nothing when the limit is zero or the prefix matches no remote", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Fix login");
        yield* arrangeBranch({ branch: "a", remoteBranches: ["a"], taskIds: [task.id] });
        return [yield* askTracked(0), yield* askTracked(50, "bitbucket.org/")];
      }),
    );
    expect(asked).toEqual([[], []]);
  });

  it("forgets the turn of a branch that is not tracked any more", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const task = yield* createTask("Fix login");
        const checkout = yield* arrangeBranch({
          branch: "a",
          remoteBranches: ["a"],
          taskIds: [task.id],
        });
        yield* arrangeBranch({ branch: "b", remoteBranches: ["b"], taskIds: [task.id] });
        yield* askTracked();
        yield* moveCheckout(checkout, "main");
        yield* askTracked();
        return yield* sql<{ readonly branch: string }>`
          SELECT branch FROM tracked_branch_attempts ORDER BY branch`;
      }),
    );
    expect(remaining).toEqual([{ branch: "b" }]);
  });
});

describe("the plan of the match", () => {
  it("reads only the joinable Tasks and reaches everything else by key, with no scan of sessions, workspaces or entities", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [text, parameters] = buildBranchMatch(sql).compile();
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          parameters,
        );
        return rows.map((row) => row.detail);
      }),
    );
    const searches = (table: string) => plan.filter((line) => line.startsWith(`SEARCH ${table} `));
    const scans = plan.filter((line) => line.startsWith("SCAN "));
    // `INDEXED BY tasks_board_rank` makes it read the joinable Tasks and not the finished ones.
    expect(scans.filter((line) => /^SCAN tasks\b/.test(line))).toEqual([
      expect.stringMatching(/^SCAN tasks USING (COVERING )?INDEX tasks_board_rank/),
    ]);
    expect(searches("s")).toEqual([expect.stringMatching(/USING INDEX \w+ \(task_id=\?\)/)]);
    expect(searches("w")).toHaveLength(1);
    expect(searches("c")).toEqual([
      expect.stringContaining("checkouts_workspace (workspace_id=?)"),
    ]);
    expect(searches("e")).toEqual([
      expect.stringContaining("external_entities_head (<expr>=? AND <expr>=?)"),
    ]);
    // The only reads of a whole table are the joinable Tasks and the few rows of the branches.
    expect(scans.filter((line) => /^SCAN (s|w|c|r|e)\b/.test(line))).toEqual([]);
  });
});
