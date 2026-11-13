/**
 * Tests the External Entity operations on real rows: a real database, a real
 * plugin host with an invented tracker plugin, and the real Task service. Only
 * the lookups that reach a source over the network are scripted.
 *
 * - taking an entity on: one Task however many callers, the stage and Project
 *   rules, a Task that finished, and the read before a Task for a record that
 *   is partial or lost access
 * - adding a thing Hercule has never seen
 * - undoing a take-on, dismissing and restoring
 * - searching and listing suggestions
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_ACTING_CONNECTIONS, MAX_LIVE_WORKFLOWS, type ExternalRef } from "@hercule/contract";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type EntityKindDeclaration,
  type EntityObservation,
  type EntityRecognition,
  type Plugin,
} from "@hercule/plugin-host";
import { CurrentActor, type Actor } from "../actor";
import { connectionRepository } from "../connections";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import {
  EntityLookups,
  PluginHost,
  type BlocksOutcome,
  type DecidedResolution,
  type SearchOutcome,
} from "../plugins";
import { buildPluginStack, IDLE_FEEDS, IDLE_INGEST_OPEN, USER } from "../plugins/testing";
import { projectRepository } from "../projects";
import { resourceRepository } from "../resources";
import { signalRepository } from "../signals/repository";
import { TaskService, TaskServiceLayer, taskRepository } from "../tasks";
import { TaskServicePortsLayer } from "../daemon/tasks";
import { externalEntityRepository, type ObservedEntity } from "./repository";
import { SettingsLayer } from "../settings";
import { narrowInboxReply } from "./inbox.testing";
import { chooseStageForEntity, ExternalEntityService, ExternalEntityServiceLayer } from "./service";
import { renderEntitySlots, type FullEntityObservation } from "./slots";

const TICKET_KIND: EntityKindDeclaration = {
  word: "ticket",
  noun: "Ticket",
  refPrefix: "acme:ticket:",
  pace: "fast",
  card: "compact",
  patience: 24,
  identifier: "{key}",
  person: null,
  owner: null,
  status: {
    todo: { shape: "ring", tone: "quiet", word: "Todo", stage: "planned" },
    doing: { shape: "half", tone: "active", word: "In progress", stage: "building" },
    backlog: { shape: "dashed", tone: "quiet", word: "Backlog" },
  },
  facts: [],
  reasons: {},
};

const PROJECT_KIND: EntityKindDeclaration = {
  word: "project",
  noun: "Project",
  refPrefix: "acme:project:",
  pace: "context",
  patience: 0,
  identifier: "{key}",
  person: null,
  owner: null,
  groupable: { caption: "Acme project" },
  status: null,
  facts: [],
  reasons: {},
};

/** An invented tracker plugin: one Connection type, and tickets that can be grouped under projects. */
const trackerPlugin: Plugin = {
  manifest: {
    id: "acme",
    displayName: "Acme",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "entities"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, {
        type: "acme",
        displayName: "Acme",
        setup: [],
        validate: () => Effect.succeed({ displayName: "Acme", accountId: "acme-1" }),
      }),
      registerEventSource(host, {
        id: "acme",
        connectionType: "acme/acme",
        feeds: IDLE_FEEDS,
        entityKinds: [TICKET_KIND, PROJECT_KIND],
        kinds: {
          "acme.thing.done": {
            description: "Something was done.",
            schema: Schema.Struct({ title: Schema.String }),
            availableToTriage: true,
          },
        },
        open: IDLE_INGEST_OPEN,
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
};

const KIND = "acme/ticket";
const ticketRef = (key: string): ExternalRef => `acme:ticket:${key}`;
const projectRef = (key: string): ExternalRef => `acme:project:${key}`;

/** What the scripted lookups do. A test replaces the parts it cares about. */
interface Script {
  resolve: (target: EntityRecognition) => DecidedResolution;
  search: () => SearchOutcome;
  recognize: (text: string) => ReadonlyArray<EntityRecognition>;
  readBlocks: () => BlocksOutcome;
  readonly resolved: Array<EntityRecognition>;
}

const buildScript = (): Script => ({
  resolve: () => ({ missing: "unknown" }),
  search: () => ({ observations: [], incomplete: false, outcome: "results" }),
  recognize: () => [],
  readBlocks: () => ({ blocks: [] }),
  resolved: [],
});

const buildLookups = (script: Script): EntityLookups["Service"] => ({
  recognize: (text) =>
    Effect.succeed(
      script.recognize(text).map((recognition) => ({ pluginId: "acme", recognition })),
    ),
  listLinkSources: () => Effect.succeed(["acme"]),
  readBlocks: () => Effect.sync(() => script.readBlocks()),
  search: () => Effect.sync(() => script.search()),
  resolve: (_pluginId, target) =>
    Effect.sync(() => {
      script.resolved.push(target);
      return script.resolve(target);
    }),
});

const A_SESSION = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  grants: ["task.read", "task.update", "task.create", "connection.read"],
} as unknown as Actor;

/** The observation of a ticket the tracker reports, as a Connection would report it. */
const buildObservation = (
  key: string,
  overrides: Partial<FullEntityObservation> = {},
): FullEntityObservation => ({
  kind: "ticket",
  ref: ticketRef(key),
  title: `Ticket ${key}`,
  url: `https://tracker.example/${key}`,
  lifecycle: "open",
  fields: { key: key.toUpperCase() },
  status: "todo",
  concerns: ["assigned"],
  sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
  ...overrides,
});

interface Arranged {
  readonly script: Script;
  /** The Connection of the plugin. */
  readonly connectionId: string;
  readonly service: ExternalEntityService["Service"];
  readonly tasks: TaskService["Service"];
  readonly sql: SqlClient.SqlClient;
  /** Stores what a Connection reports, as a poll would. */
  readonly report: (
    connectionId: string,
    observations: ReadonlyArray<EntityObservation>,
  ) => Effect.Effect<void, unknown>;
  /** Stores a ticket's partial record, as a read of something that mentions it would. */
  readonly reportPartial: (key: string) => Effect.Effect<void, unknown>;
  /** Returns the id of the entity of a ref. */
  readonly entityId: (ref: string) => Effect.Effect<string, unknown>;
  /** Inserts another Connection of the plugin, which is another account. */
  readonly insertAccount: (accountId: string) => Effect.Effect<string, unknown>;
  readonly countTasks: Effect.Effect<number, unknown>;
}

/** The list that holds every thing on the Inbox. */
const EVERYTHING = { mode: "first", list: { savedQuery: "everything" } } as const;

/** Reads the first page of the list that holds every thing. */
const readEverything = (service: ExternalEntityService["Service"]) =>
  Effect.map(service.queryInbox(EVERYTHING), (reply) => narrowInboxReply("first", reply));

const buildLayer = (script: Script) =>
  ExternalEntityServiceLayer.pipe(
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(Layer.succeed(EntityLookups)(buildLookups(script))),
    Layer.provideMerge(
      TaskServiceLayer.pipe(
        Layer.provideMerge(NotifierLayer),
        Layer.provideMerge(TaskServicePortsLayer),
        Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
      ),
    ),
    Layer.provideMerge(buildPluginStack()),
  );

/** Runs `body` as the user on a fresh database, with the tracker plugin running and one Connection. */
const run = <A>(
  body: (arranged: Arranged) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
): Promise<A> => {
  const script = buildScript();
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const host = yield* PluginHost;
      yield* host.boot([trackerPlugin]);
      const connections = yield* connectionRepository;
      const entities = yield* externalEntityRepository;
      const kinds = yield* host.listEntityKinds("acme");
      const at = new Date().toISOString();

      const insertAccount = (accountId: string) =>
        Effect.map(
          withTransaction(
            sql,
            connections.insert({
              pluginId: "acme",
              type: "acme/acme",
              label: accountId,
              displayName: accountId,
              accountId,
              labels: [],
              config: {},
              at,
            }),
          ),
          (inserted) => inserted.id,
        );

      const render = (observation: EntityObservation) =>
        Effect.gen(function* () {
          const declaration = kinds.find(
            (candidate) => candidate.word === `acme/${observation.kind}`,
          )!;
          if (observation.partial === true) {
            const entity: ObservedEntity = {
              kind: declaration.word,
              observation,
              slots: { noun: declaration.noun, pace: "context" },
            };
            return entity;
          }
          const slots = yield* renderEntitySlots(declaration, observation);
          const entity: ObservedEntity = {
            kind: declaration.word,
            observation,
            slots,
            fieldRows: [],
          };
          return entity;
        });

      const report = (connectionId: string, observations: ReadonlyArray<EntityObservation>) =>
        Effect.gen(function* () {
          const observed = yield* Effect.forEach(observations, render);
          const byKind = new Map<string, Array<ObservedEntity>>();
          for (const entity of observed) {
            byKind.set(entity.kind, [...(byKind.get(entity.kind) ?? []), entity]);
          }
          for (const [kind, group] of byKind) {
            yield* withTransaction(
              sql,
              entities.reconcile({
                connectionId,
                kind,
                complete: false,
                observed: group,
                actor: "plugin:acme",
                environment: { now: at, activePluginIds: ["acme"] },
              }),
            );
          }
        });

      const connectionId = yield* insertAccount("acme-1");
      return yield* body({
        script,
        connectionId,
        service: yield* ExternalEntityService,
        tasks: yield* TaskService,
        sql,
        report,
        reportPartial: (key) =>
          report(connectionId, [
            { kind: "ticket", ref: ticketRef(key), title: `Ticket ${key}`, partial: true },
          ]),
        entityId: (ref) =>
          Effect.map(entities.readTaskableEntity({ ref }), (found) => Option.getOrThrow(found).id),
        insertAccount,
        countTasks: Effect.map(
          sql<{ readonly n: number }>`SELECT count(*) AS n FROM tasks`,
          (rows) => rows[0]!.n,
        ),
      });
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(buildLayer(script)),
    ) as Effect.Effect<A>,
  );
};

describe("takeOn", () => {
  it("makes one Task when two callers take the same entity on at once", async () => {
    const { results, taskCount } = await run(
      ({ service, report, connectionId, entityId, countTasks }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1")]);
          const id = yield* entityId(ticketRef("1"));
          const results = yield* Effect.all([service.takeOn(id), service.takeOn(id)], {
            concurrency: 2,
          });
          return { results, taskCount: yield* countTasks };
        }),
    );
    expect(taskCount).toBe(1);
    expect(results[0].taskId).toBe(results[1].taskId);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("gives a second account the Task the first one made", async () => {
    const results = await run(({ service, report, connectionId, insertAccount, entityId }) =>
      Effect.gen(function* () {
        const second = yield* insertAccount("acme-2");
        yield* report(connectionId, [buildObservation("1")]);
        yield* report(second, [buildObservation("1")]);
        const id = yield* entityId(ticketRef("1"));
        return [yield* service.takeOn(id), yield* service.takeOn(id)];
      }),
    );
    expect(results[1]).toEqual({ taskId: results[0]!.taskId, created: false });
  });

  it("takes on a Task that something else made, once, and keeps the first time", async () => {
    const { first, second, links } = await run(
      ({ service, sql, report, connectionId, entityId, countTasks }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1")]);
          const id = yield* entityId(ticketRef("1"));
          const tasks = yield* taskRepository;
          // A Task made some other way (a hand-off, a session): its link is not taken.
          const other = yield* withTransaction(
            sql,
            tasks.insert({
              title: "Made by a session",
              description: "",
              status: "open",
              stage: "planned",
              priority: "normal",
              labels: [],
              projectId: undefined,
              provenance: [{ ref: ticketRef("1") }],
              at: "2026-03-01T00:00:00.000Z",
              actor: "session:0190c000-0000-7000-8000-0000000000e1",
            }),
          );
          const first = yield* service.takeOn(id);
          const second = yield* service.takeOn(id);
          const links = yield* sql<{
            readonly task_id: Uint8Array;
            readonly taken_at: string | null;
            readonly taken_by: string | null;
            readonly linked_by: string;
          }>`SELECT task_id, taken_at, taken_by, linked_by FROM task_entity_links`;
          expect(yield* countTasks).toBe(1);
          expect(first.taskId).toBe(other.id);
          return { first, second, links };
        }),
    );
    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
    expect(links).toHaveLength(1);
    expect(links[0]!.taken_at).not.toBeNull();
    // The link that was marked is the Task the call returned, stamped with the user,
    // and the link keeps its original author.
    expect(uuidToString(links[0]!.task_id)).toBe(first.taskId);
    expect(links[0]!.taken_by).toBe("user");
    expect(links[0]!.linked_by).toBe("session:0190c000-0000-7000-8000-0000000000e1");
  });

  it("fails NotFound for an unknown id", async () => {
    const error = await run(({ service }) =>
      Effect.flip(service.takeOn("0199e0e7-9999-7000-8000-000000000000")),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("makes a new Task for an entity whose Task finished", async () => {
    const { first, second } = await run(({ service, tasks, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const id = yield* entityId(ticketRef("1"));
        const first = yield* service.takeOn(id);
        yield* tasks.update({ id: first.taskId, stage: "done" });
        const second = yield* service.takeOn(id);
        return { first, second };
      }),
    );
    expect(second.created).toBe(true);
    expect(second.taskId).not.toBe(first.taskId);
  });

  it("refuses a session, even one that holds the grants", async () => {
    const error = await run(({ service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const id = yield* entityId(ticketRef("1"));
        return yield* Effect.flip(
          Effect.provideService(service.takeOn(id), CurrentActor, A_SESSION),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });

  it("refuses the Inbox and the detail to a session that lacks a grant they need, and the detail does not need the run grant", async () => {
    const ALL = ["task.read", "signal.read", "workflow.read", "connection.read", "run.read"];
    const refused = await run(({ service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const id = yield* entityId(ticketRef("1"));
        return yield* Effect.forEach(ALL, (missing) => {
          const actor = {
            ...A_SESSION,
            grants: ALL.filter((grant) => grant !== missing),
          } as unknown as Actor;
          return Effect.all([
            Effect.flip(Effect.provideService(readEverything(service), CurrentActor, actor)),
            Effect.exit(Effect.provideService(service.read(id), CurrentActor, actor)),
          ]).pipe(Effect.map(([inbox, detail]) => ({ missing, inbox, detail })));
        });
      }),
    );
    for (const { missing, inbox, detail } of refused) {
      expect(inbox).toMatchObject({ error: { code: "forbidden", details: { grant: missing } } });
      if (missing === "run.read") {
        expect(detail._tag).toBe("Success");
      } else {
        expect(detail).toMatchObject({
          cause: {
            reasons: [{ error: { error: { code: "forbidden", details: { grant: missing } } } }],
          },
        });
      }
    }
  });

  it("refuses the group of a thing to a session without the grants for the Inbox's text, and reads it with them", async () => {
    const result = await run(({ service, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const as = (grants: ReadonlyArray<string>) =>
          Effect.provideService(service.readInboxGroup(ticketRef("1")), CurrentActor, {
            ...A_SESSION,
            grants,
          } as unknown as Actor);
        return {
          noSignals: yield* Effect.flip(as(["task.read"])),
          noTasks: yield* Effect.flip(as(["signal.read"])),
          allowed: yield* as(["task.read", "signal.read"]),
        };
      }),
    );
    expect(result.noSignals).toMatchObject({
      error: { code: "forbidden", details: { grant: "signal.read" } },
    });
    expect(result.noTasks).toMatchObject({
      error: { code: "forbidden", details: { grant: "task.read" } },
    });
    expect(result.allowed.labelRef).toBe(ticketRef("1"));
  });

  it("refuses a place, saying why", async () => {
    const error = await run(({ service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [
          {
            kind: "project",
            ref: projectRef("harbour"),
            title: "Harbour",
            fields: { key: "HARBOUR" },
            concerns: [],
            sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
          },
        ]);
        const id = yield* entityId(projectRef("harbour"));
        return yield* Effect.flip(service.takeOn(id));
      }),
    );
    expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(JSON.stringify(error)).toContain("place");
  });

  describe("the stage", () => {
    it("is the stage the status declares, else planned", async () => {
      const { stages, doingStatus } = await run(
        ({ service, tasks, report, connectionId, entityId }) =>
          Effect.gen(function* () {
            yield* report(connectionId, [
              buildObservation("todo", { status: "todo" }),
              buildObservation("doing", { status: "doing" }),
              buildObservation("backlog", { status: "backlog" }),
              {
                kind: "ticket",
                ref: ticketRef("bare"),
                title: "Ticket bare",
                url: "https://tracker.example/bare",
                lifecycle: "open",
                fields: { key: "BARE" },
                concerns: ["assigned"],
                sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
              },
            ]);
            const stages: Record<string, string> = {};
            for (const key of ["todo", "doing", "backlog", "bare"]) {
              const made = yield* service.takeOn(yield* entityId(ticketRef(key)));
              stages[key] = (yield* tasks.read(made.taskId)).stage;
            }
            const doing = yield* service.read(yield* entityId(ticketRef("doing")));
            return { stages, doingStatus: doing.status };
          }),
      );
      expect(stages).toEqual({
        todo: "planned",
        doing: "building",
        backlog: "planned",
        bare: "planned",
      });
      // The stage is stored beside the status, and the API does not show it.
      expect(doingStatus).toEqual({ shape: "half", tone: "active", label: "In progress" });
    });

    it("is planned for a thing with no stored stage", () => {
      expect(chooseStageForEntity({ stage: undefined })).toBe("planned");
    });
  });

  describe("the Project", () => {
    const REMOTE = "github.com/acme/web";

    /**
     * Puts a ticket that lands in `REMOTE` on the Inbox, and files that
     * repository's Resource under `projectNames` and under `deletedNames`,
     * which are then deleted.
     */
    const arrange =
      (
        projectNames: ReadonlyArray<string>,
        withResource: boolean,
        deletedNames: ReadonlyArray<string> = [],
      ) =>
      (arranged: Arranged) =>
        Effect.gen(function* () {
          const { sql, report, connectionId, entityId, service, tasks } = arranged;
          const at = new Date().toISOString();
          const resources = yield* resourceRepository;
          const projects = yield* projectRepository;
          const projectIds: Array<string> = [];
          yield* withTransaction(
            sql,
            Effect.gen(function* () {
              for (const name of projectNames) {
                projectIds.push((yield* projects.insert({ name, description: undefined, at })).id);
              }
              const deletedIds: Array<string> = [];
              for (const name of deletedNames) {
                const deleted = yield* projects.insert({ name, description: undefined, at });
                yield* projects.softDelete(deleted.id, at);
                deletedIds.push(deleted.id);
              }
              if (!withResource) return;
              const resource = yield* resources.insert({
                kind: "repo",
                remote: `https://${REMOTE}.git`,
                canonicalRemote: REMOTE,
                label: null,
                connectionId: null,
                setupCommand: null,
                workspaceInclude: true,
                at,
              });
              yield* resources.setProjects(resource.id, [...projectIds, ...deletedIds]);
            }),
          );
          yield* report(connectionId, [
            buildObservation("1", { repository: { target: { remote: REMOTE } } }),
          ]);
          const made = yield* service.takeOn(yield* entityId(ticketRef("1")));
          return { projectId: (yield* tasks.read(made.taskId)).projectId, projectIds };
        });

    it("is the only Project of the Resource the repository points at", async () => {
      const { projectId, projectIds } = await run(arrange(["Web"], true));
      expect(projectId).toBe(projectIds[0]);
    });

    it("is none when the Resource is in two Projects", async () => {
      expect((await run(arrange(["Web", "Shop"], true))).projectId).toBeUndefined();
    });

    it("is none when no Resource has that remote", async () => {
      expect((await run(arrange(["Web"], false))).projectId).toBeUndefined();
    });

    it("is none when the only Project of the Resource was deleted, and the Task is still made", async () => {
      expect((await run(arrange([], true, ["Old"]))).projectId).toBeUndefined();
    });

    it("is the live Project when the Resource is also filed under a deleted one", async () => {
      const { projectId, projectIds } = await run(arrange(["Web"], true, ["Old"]));
      expect(projectId).toBe(projectIds[0]);
    });
  });

  describe("the read before a Task", () => {
    it("reads a thing it holds only in part, and then makes the Task", async () => {
      const { made, resolved } = await run((arranged) =>
        Effect.gen(function* () {
          const { script, service, reportPartial, entityId, connectionId } = arranged;
          yield* reportPartial("1");
          script.resolve = () => ({
            found: { connectionId, observation: buildObservation("1") },
          });
          const made = yield* service.takeOn(yield* entityId(ticketRef("1")));
          return { made, resolved: script.resolved };
        }),
      );
      expect(made.created).toBe(true);
      expect(resolved).toEqual([
        { recognized: "ref", form: "identifier", ref: ticketRef("1"), kind: KIND },
      ]);
    });

    it("reads a thing that lost access first, and makes no Task when the read fails", async () => {
      const { error, taskCount } = await run((arranged) =>
        Effect.gen(function* () {
          const { script, service, report, connectionId, sql, entityId, countTasks } = arranged;
          yield* report(connectionId, [buildObservation("1")]);
          const entities = yield* externalEntityRepository;
          yield* withTransaction(
            sql,
            entities.reportMissing({
              connectionId,
              ref: ticketRef("1"),
              reason: "inaccessible",
              environment: {
                now: new Date().toISOString(),
                activePluginIds: ["acme"],
              },
            }),
          );
          script.resolve = () => ({ missing: "inaccessible" });
          const error = yield* Effect.flip(service.takeOn(yield* entityId(ticketRef("1"))));
          return { error, taskCount: yield* countTasks };
        }),
      );
      expect(error).toMatchObject({ error: { code: "invalid_state" } });
      expect(taskCount).toBe(0);
    });

    it("refuses a partial answer, and makes no Task", async () => {
      const { error, taskCount } = await run((arranged) =>
        Effect.gen(function* () {
          const { script, service, reportPartial, connectionId, entityId, countTasks } = arranged;
          yield* reportPartial("1");
          script.resolve = () => ({
            found: {
              connectionId,
              observation: {
                kind: "ticket",
                ref: ticketRef("1"),
                title: "Only a title",
                partial: true,
              },
            },
          });
          const error = yield* Effect.flip(service.takeOn(yield* entityId(ticketRef("1"))));
          return { error, taskCount: yield* countTasks };
        }),
      );
      expect(error).toMatchObject({ error: { code: "invalid_state" } });
      expect(taskCount).toBe(0);
    });

    it("refuses an answer about another ref", async () => {
      const error = await run((arranged) =>
        Effect.gen(function* () {
          const { script, service, reportPartial, connectionId, entityId } = arranged;
          yield* reportPartial("1");
          script.resolve = () => ({
            found: { connectionId, observation: buildObservation("2") },
          });
          return yield* Effect.flip(service.takeOn(yield* entityId(ticketRef("1"))));
        }),
      );
      expect(error).toMatchObject({ error: { code: "invalid_state" } });
    });

    it("makes no Task for a record that loses access between the check and the write", async () => {
      const { error, taskCount, resolvedCount } = await run((arranged) =>
        Effect.gen(function* () {
          const { script, service, report, connectionId, sql, entityId, countTasks } = arranged;
          yield* report(connectionId, [buildObservation("1")]);
          const id = yield* entityId(ticketRef("1"));
          const entities = yield* externalEntityRepository;
          // Holds the writer while access is taken away, so the take-on has
          // checked the rows (they look fine) and waits to write.
          const holding = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* Effect.forkChild(
            withTransaction(
              sql,
              Effect.andThen(
                entities.reportMissing({
                  connectionId,
                  ref: ticketRef("1"),
                  reason: "inaccessible",
                  environment: {
                    now: new Date().toISOString(),
                    activePluginIds: ["acme"],
                  },
                }),
                Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(release)),
              ),
            ),
          );
          yield* Deferred.await(holding);
          const taking = yield* Effect.forkChild(Effect.flip(service.takeOn(id)));
          // The database driver is synchronous, so the take-on runs its check and
          // stops at the writer within a few turns of the scheduler. No clock is
          // involved. If it had not got there yet, it would read the lost access
          // itself and call the lookups, which the assertion below catches.
          yield* Effect.repeat(Effect.yieldNow, { times: 100 });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          const error = yield* Fiber.join(taking);
          return {
            error,
            taskCount: yield* countTasks,
            resolvedCount: script.resolved.length,
          };
        }),
      );
      // The read never happened, so the failure came from the check in the transaction.
      expect(resolvedCount).toBe(0);
      expect(error).toMatchObject({ error: { code: "conflict" } });
      expect(taskCount).toBe(0);
    });
  });
});

describe("readBlocks", () => {
  const ARRANGE_ONE = ({ report, connectionId, entityId }: Arranged) =>
    Effect.gen(function* () {
      yield* report(connectionId, [buildObservation("1")]);
      return yield* entityId(ticketRef("1"));
    });

  it("returns the blocks the lookup read, checked against the contract", async () => {
    const reply = await run((arranged) =>
      Effect.gen(function* () {
        arranged.script.readBlocks = () => ({
          blocks: [
            { type: "text", markdown: "hello" },
            { type: "code", text: "const a = 1;" },
          ],
        });
        return yield* arranged.service.readBlocks(yield* ARRANGE_ONE(arranged));
      }),
    );
    expect(reply).toEqual({
      blocks: [
        { type: "text", markdown: "hello" },
        { type: "code", text: "const a = 1;" },
      ],
    });
  });

  it("returns no blocks for a plugin that offers none", async () => {
    const reply = await run((arranged) =>
      Effect.gen(function* () {
        return yield* arranged.service.readBlocks(yield* ARRANGE_ONE(arranged));
      }),
    );
    expect(reply).toEqual({ blocks: [] });
  });

  it("fails with one safe error when no Connection could read, a draft breaks the contract, or its type is misspelled", async () => {
    const errors = await run((arranged) =>
      Effect.gen(function* () {
        const id = yield* ARRANGE_ONE(arranged);
        arranged.script.readBlocks = () => ({ unreadable: true });
        const unreadable = yield* Effect.flip(arranged.service.readBlocks(id));
        arranged.script.readBlocks = () => ({
          blocks: [{ type: "fields", rows: [] }],
        });
        const invalid = yield* Effect.flip(arranged.service.readBlocks(id));
        arranged.script.readBlocks = () => ({
          blocks: [{ type: "calender", day: "2026-11-12" }],
        });
        const misspelled = yield* Effect.flip(arranged.service.readBlocks(id));
        return [unreadable, invalid, misspelled];
      }),
    );
    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "invalid_state", details: { reason: "source-unreadable" } },
      });
    }
    expect(errors[1]).toEqual(errors[0]);
    expect(errors[2]).toEqual(errors[0]);
  });

  it("refuses an unknown id, a place, and a session without the grants", async () => {
    const { unknown, place, forbidden } = await run((arranged) =>
      Effect.gen(function* () {
        const id = yield* ARRANGE_ONE(arranged);
        yield* arranged.report(arranged.connectionId, [
          {
            kind: "project",
            ref: projectRef("harbour"),
            title: "Harbour",
            fields: { key: "HARBOUR" },
            concerns: [],
            sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
          },
        ]);
        const noGrants = { ...A_SESSION, grants: ["task.read"] } as unknown as Actor;
        return {
          unknown: yield* Effect.flip(
            arranged.service.readBlocks("0199e0e7-0000-7000-8000-000000000000"),
          ),
          place: yield* Effect.flip(
            arranged.service.readBlocks(yield* arranged.entityId(projectRef("harbour"))),
          ),
          forbidden: yield* Effect.flip(
            Effect.provideService(arranged.service.readBlocks(id), CurrentActor, noGrants),
          ),
        };
      }),
    );
    expect(unknown).toMatchObject({ error: { code: "not_found" } });
    expect(place).toMatchObject({ error: { code: "not_found" } });
    expect(forbidden).toMatchObject({
      error: { code: "forbidden", details: { grant: "signal.read" } },
    });
  });
});

describe("addToWork", () => {
  it("creates the entity and then the Task for a thing Hercule has never seen, and follows it", async () => {
    const { result, task, followed, inbox, stillThere } = await run((arranged) =>
      Effect.gen(function* () {
        const { script, service, tasks, sql, connectionId, entityId } = arranged;
        script.resolve = () => ({
          found: {
            connectionId,
            observation: buildObservation("9", { status: "doing", concerns: [] }),
          },
        });
        const result = yield* service.addToWork({ ref: ticketRef("9") });
        const followed = (yield* service.read(yield* entityId(ticketRef("9")))).concerns;
        // A poll that lists nothing must not take the entity off Work.
        const entities = yield* externalEntityRepository;
        yield* withTransaction(
          sql,
          entities.reconcile({
            connectionId,
            kind: KIND,
            complete: true,
            observed: [],
            actor: "plugin:acme",
            environment: {
              now: new Date().toISOString(),
              activePluginIds: ["acme"],
            },
          }),
        );
        const id = yield* entityId(ticketRef("9"));
        const detail = yield* service.read(id);
        return {
          result,
          task: yield* tasks.read(result.taskId),
          followed,
          inbox: yield* readEverything(service),
          stillThere: detail.concerns,
        };
      }),
    );
    expect(result).toMatchObject({ created: true, stage: "building", followed: true });
    expect(task).toMatchObject({ stage: "building", title: "Ticket 9" });
    expect(followed).toEqual(["following"]);
    expect(inbox.things.map((card) => card.ref)).toEqual([ticketRef("9")]);
    expect(inbox.things[0]).toMatchObject({ taskId: task.id });
    expect(stillThere).toEqual(["following"]);
  });

  it("fails Conflict and stores nothing when the account that read the thing can no longer read", async () => {
    const outcome = await run(({ script, service, sql, connectionId, countTasks }) =>
      Effect.gen(function* () {
        script.resolve = () => ({
          found: { connectionId, observation: buildObservation("9") },
        });
        // The account leaves the ingesting statuses while the lookup waits.
        yield* withTransaction(
          sql,
          sql`UPDATE connections SET status = 'disabled' WHERE id = ${uuidFromString(connectionId)}`,
        );
        const error = yield* Effect.flip(service.addToWork({ ref: ticketRef("9") }));
        return {
          failure: "error" in error ? error.error.code : "other",
          tasks: yield* countTasks,
          entities: (yield* sql<{
            readonly n: number;
          }>`SELECT count(*) AS n FROM external_entities`)[0]!.n,
        };
      }),
    );
    expect(outcome.failure).toBe("conflict");
    expect(outcome.tasks).toBe(0);
    expect(outcome.entities).toBe(0);
  });

  it("does not follow a thing that concerns the user already", async () => {
    const result = await run(({ script, service, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        script.resolve = () => ({ found: { connectionId, observation: buildObservation("1") } });
        return yield* service.addToWork({ ref: ticketRef("1") });
      }),
    );
    expect(result.followed).toBe(false);
    expect(result.created).toBe(true);
  });

  it("returns the active Task of a thing it holds, without a read", async () => {
    const { first, second, resolved } = await run(({ script, service, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const first = yield* service.addToWork({ ref: ticketRef("1") });
        const second = yield* service.addToWork({ ref: ticketRef("1") });
        return { first, second, resolved: script.resolved };
      }),
    );
    expect(second).toMatchObject({ id: first.id, taskId: first.taskId, created: false });
    expect(resolved).toEqual([]);
  });

  it("returns the active Task that links a ref Hercule holds no record of, without a read", async () => {
    const { result, made, resolved, taskCount } = await run(
      ({ script, service, tasks, countTasks }) =>
        Effect.gen(function* () {
          const made = yield* tasks.create({
            title: "Written by an agent",
            description: "",
            provenance: [{ ref: ticketRef("unseen") }],
          });
          const result = yield* service.addToWork({ ref: ticketRef("unseen") });
          return { result, made, resolved: script.resolved, taskCount: yield* countTasks };
        }),
    );
    expect(result).toEqual({
      taskId: made.id,
      created: false,
      stage: made.stage,
      followed: false,
    });
    expect(resolved).toEqual([]);
    expect(taskCount).toBe(1);
  });

  it("files the Task under the Project the user picked", async () => {
    const { projectId, picked } = await run(({ script, service, tasks, sql, connectionId }) =>
      Effect.gen(function* () {
        const projects = yield* projectRepository;
        const picked = yield* withTransaction(
          sql,
          projects.insert({ name: "Web", description: undefined, at: new Date().toISOString() }),
        );
        script.resolve = () => ({ found: { connectionId, observation: buildObservation("9") } });
        const result = yield* service.addToWork({ ref: ticketRef("9"), projectId: picked.id });
        return { projectId: (yield* tasks.read(result.taskId)).projectId, picked: picked.id };
      }),
    );
    expect(projectId).toBe(picked);
  });

  it("fails NotFound for a Project that does not exist, and makes no Task", async () => {
    const { error, taskCount } = await run(({ script, service, connectionId, countTasks }) =>
      Effect.gen(function* () {
        script.resolve = () => ({ found: { connectionId, observation: buildObservation("9") } });
        const error = yield* Effect.flip(
          service.addToWork({
            ref: ticketRef("9"),
            projectId: "0199e0e7-9999-7000-8000-000000000000",
          }),
        );
        return { error, taskCount: yield* countTasks };
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
    expect(taskCount).toBe(0);
  });

  it("refuses a context kind, and a ref no plugin owns", async () => {
    const errors = await run(({ service }) =>
      Effect.all([
        Effect.flip(service.addToWork({ ref: projectRef("harbour") })),
        Effect.flip(service.addToWork({ ref: "other:thing:1" })),
      ]),
    );
    expect(errors).toMatchObject([
      { error: { code: "invalid_state" } },
      { error: { code: "invalid_state" } },
    ]);
  });
});

describe("undoTakeOn", () => {
  it("deletes the Task a take-on made, and a second undo leaves a newer Task alone", async () => {
    const { first, second, survivor, gone } = await run(
      ({ service, tasks, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1")]);
          const id = yield* entityId(ticketRef("1"));
          const made = yield* service.takeOn(id);
          const first = yield* service.undoTakeOn(id, made.taskId);
          const again = yield* service.takeOn(id);
          // The old id again: it must not reach the new Task.
          const second = yield* service.undoTakeOn(id, made.taskId);
          const survivor = yield* tasks.read(again.taskId);
          const gone = yield* Effect.flip(tasks.read(made.taskId));
          return { first, second, survivor, gone };
        }),
    );
    expect(first).toEqual({ undone: true });
    expect(second.undone).toBe(false);
    expect(survivor.id).toBeDefined();
    expect(gone).toMatchObject({ error: { code: "not_found" } });
  });

  it("keeps a Task that was edited, or that links another thing", async () => {
    const { edited, linked } = await run(({ service, tasks, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        const one = yield* entityId(ticketRef("1"));
        const two = yield* entityId(ticketRef("2"));
        const madeOne = yield* service.takeOn(one);
        const madeTwo = yield* service.takeOn(two);
        yield* tasks.update({ id: madeOne.taskId, title: "Renamed" });
        yield* tasks.update({ id: madeTwo.taskId, provenance: [{ ref: ticketRef("1") }] });
        return {
          edited: yield* service.undoTakeOn(one, madeOne.taskId),
          linked: yield* service.undoTakeOn(two, madeTwo.taskId),
        };
      }),
    );
    expect(edited.undone).toBe(false);
    expect(edited.reason).toContain("edited");
    expect(linked.undone).toBe(false);
    expect(linked.reason).toContain("another thing");
  });

  it("keeps the Task of another entity", async () => {
    const { outcome, stillLive } = await run(({ service, tasks, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        const madeTwo = yield* service.takeOn(yield* entityId(ticketRef("2")));
        const outcome = yield* service.undoTakeOn(yield* entityId(ticketRef("1")), madeTwo.taskId);
        return { outcome, stillLive: (yield* tasks.read(madeTwo.taskId)).id === madeTwo.taskId };
      }),
    );
    expect(outcome.undone).toBe(false);
    expect(stillLive).toBe(true);
  });

  it("refuses a session", async () => {
    const error = await run(({ service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const id = yield* entityId(ticketRef("1"));
        const made = yield* service.takeOn(id);
        return yield* Effect.flip(
          Effect.provideService(service.undoTakeOn(id, made.taskId), CurrentActor, A_SESSION),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

/** Reads the links of a Task: the ref, and whether and when the user took it on. */
const readLinks = (sql: SqlClient.SqlClient, taskId: string) =>
  Effect.map(
    sql<{ readonly ref: string; readonly taken_at: string | null }>`
      SELECT ref, taken_at FROM task_entity_links
      WHERE task_id = ${uuidFromString(taskId)} ORDER BY ref`,
    (rows) => rows.map((row) => [row.ref, row.taken_at !== null] as const),
  );

describe("takeOnTogether and undoTakeOnTogether", () => {
  it("makes one Task for things that have none, linked and taken, with the stage of the first", async () => {
    const { result, links, task, taskCount, ids } = await run(
      ({ service, tasks, sql, report, connectionId, entityId, countTasks }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [
            buildObservation("1", { status: "doing" }),
            buildObservation("2"),
          ]);
          const ids = [yield* entityId(ticketRef("1")), yield* entityId(ticketRef("2"))];
          const result = yield* service.takeOnTogether({ ids, title: "Both tickets" });
          return {
            result,
            ids,
            links: yield* readLinks(sql, result.taskId),
            task: yield* tasks.read(result.taskId),
            taskCount: yield* countTasks,
          };
        }),
    );
    expect(result).toMatchObject({ created: true, added: ids, taken: ids });
    expect(links).toEqual([
      [ticketRef("1"), true],
      [ticketRef("2"), true],
    ]);
    expect(task).toMatchObject({ title: "Both tickets", stage: "building" });
    expect(taskCount).toBe(1);
  });

  it("joins the Task that things share, adding only the new links and taking every link on", async () => {
    const { result, links, taskCount, earlierId } = await run(
      ({ service, tasks, sql, report, connectionId, entityId, countTasks }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
          const one = yield* entityId(ticketRef("1"));
          const two = yield* entityId(ticketRef("2"));
          // A Task that something else made: its link is not taken on yet.
          const earlier = yield* tasks.create({
            title: "Earlier",
            description: "",
            stage: "planned",
            provenance: [{ ref: ticketRef("1") }],
          });
          const result = yield* service.takeOnTogether({ ids: [one, two], title: "Unused" });
          return {
            result: { ...result, one, two },
            earlierId: earlier.id,
            links: yield* readLinks(sql, earlier.id),
            taskCount: yield* countTasks,
          };
        }),
    );
    expect(result).toMatchObject({
      taskId: earlierId,
      created: false,
      added: [result.two],
      taken: [result.one, result.two],
    });
    expect(links).toEqual([
      [ticketRef("1"), true],
      [ticketRef("2"), true],
    ]);
    expect(taskCount).toBe(1);
  });

  it("refuses things on two different Tasks, naming them, and writes nothing", async () => {
    const { error, taskCount } = await run(
      ({ service, report, connectionId, entityId, countTasks }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
          const one = yield* entityId(ticketRef("1"));
          const two = yield* entityId(ticketRef("2"));
          yield* service.takeOn(one);
          yield* service.takeOn(two);
          const error = yield* Effect.flip(
            service.takeOnTogether({ ids: [one, two], title: "Together" }),
          );
          return { error, taskCount: yield* countTasks };
        }),
    );
    expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(JSON.stringify(error)).toContain("Ticket 1");
    expect(JSON.stringify(error)).toContain("Ticket 2");
    expect(taskCount).toBe(2);
  });

  it("fails like takeOn for a place or an unknown id, and for a session, and makes no Task", async () => {
    const { place, unknown, session, taskCount } = await run(
      ({ service, report, connectionId, entityId, countTasks }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [
            buildObservation("1"),
            {
              kind: "project",
              ref: projectRef("harbour"),
              title: "Harbour",
              fields: { key: "HARBOUR" },
              concerns: [],
              sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
            },
          ]);
          const one = yield* entityId(ticketRef("1"));
          const harbour = yield* entityId(projectRef("harbour"));
          return {
            place: yield* Effect.flip(service.takeOnTogether({ ids: [one, harbour], title: "x" })),
            unknown: yield* Effect.flip(
              service.takeOnTogether({
                ids: [one, "0199e0e7-9999-7000-8000-000000000000"],
                title: "x",
              }),
            ),
            session: yield* Effect.flip(
              Effect.provideService(
                service.takeOnTogether({ ids: [one, harbour], title: "x" }),
                CurrentActor,
                A_SESSION,
              ),
            ),
            taskCount: yield* countTasks,
          };
        }),
    );
    expect(place).toMatchObject({ error: { code: "invalid_state" } });
    expect(unknown).toMatchObject({ error: { code: "not_found" } });
    expect(session).toMatchObject({ error: { code: "forbidden" } });
    expect(taskCount).toBe(0);
  });

  it("deletes the Task it made when nothing was added, and keeps it once it was edited", async () => {
    const { undone, kept, gone } = await run(({ service, tasks, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        const ids = [yield* entityId(ticketRef("1")), yield* entityId(ticketRef("2"))];
        const first = yield* service.takeOnTogether({ ids, title: "First" });
        const undone = yield* service.undoTakeOnTogether(first);
        const second = yield* service.takeOnTogether({ ids, title: "Second" });
        yield* tasks.update({ id: second.taskId, title: "Renamed" });
        return {
          undone,
          kept: yield* service.undoTakeOnTogether(second),
          gone: yield* Effect.flip(tasks.read(first.taskId)),
        };
      }),
    );
    expect(undone).toEqual({ undone: true });
    expect(kept.undone).toBe(false);
    expect(kept.reason).toContain("edited");
    expect(gone).toMatchObject({ error: { code: "not_found" } });
  });

  it("takes back a join: removes what it linked, clears what it took on, keeps the Task", async () => {
    const { undone, links, stillLive } = await run(
      ({ service, tasks, sql, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
          const ids = [yield* entityId(ticketRef("1")), yield* entityId(ticketRef("2"))];
          const earlier = yield* tasks.create({
            title: "Earlier",
            description: "",
            stage: "planned",
            provenance: [{ ref: ticketRef("1") }],
          });
          const joined = yield* service.takeOnTogether({ ids, title: "Unused" });
          const undone = yield* service.undoTakeOnTogether(joined);
          return {
            undone,
            links: yield* readLinks(sql, earlier.id),
            stillLive: (yield* tasks.read(earlier.id)).id === earlier.id,
          };
        }),
    );
    expect(undone).toEqual({ undone: true });
    expect(links).toEqual([[ticketRef("1"), false]]);
    expect(stillLive).toBe(true);
  });

  it("has a real undo when every thing already links the Task: it clears the taken mark", async () => {
    const { joined, undone, links } = await run(
      ({ service, tasks, sql, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
          const ids = [yield* entityId(ticketRef("1")), yield* entityId(ticketRef("2"))];
          const earlier = yield* tasks.create({
            title: "Earlier",
            description: "",
            stage: "planned",
            provenance: [{ ref: ticketRef("1") }, { ref: ticketRef("2") }],
          });
          const joined = yield* service.takeOnTogether({ ids, title: "Unused" });
          const undone = yield* service.undoTakeOnTogether(joined);
          return { joined, undone, links: yield* readLinks(sql, earlier.id) };
        }),
    );
    expect(joined).toMatchObject({ created: false, added: [] });
    expect(joined.taken).toHaveLength(2);
    expect(undone).toEqual({ undone: true });
    expect(links).toEqual([
      [ticketRef("1"), false],
      [ticketRef("2"), false],
    ]);
  });

  it("refuses to undo a join when a link no longer holds the time the call wrote", async () => {
    const { undone, links } = await run(({ service, tasks, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        const ids = [yield* entityId(ticketRef("1")), yield* entityId(ticketRef("2"))];
        const earlier = yield* tasks.create({
          title: "Earlier",
          description: "",
          stage: "planned",
          provenance: [{ ref: ticketRef("1") }],
        });
        const joined = yield* service.takeOnTogether({ ids, title: "Unused" });
        // Something else took the second link on again, later.
        yield* withTransaction(
          sql,
          sql`UPDATE task_entity_links SET taken_at = '2030-01-01T00:00:00.000Z'
              WHERE task_id = ${uuidFromString(earlier.id)} AND ref = ${ticketRef("2")}`,
        );
        const undone = yield* service.undoTakeOnTogether(joined);
        return { undone, links: yield* readLinks(sql, earlier.id) };
      }),
    );
    expect(undone.undone).toBe(false);
    expect(undone.reason).toContain("changed");
    expect(links).toEqual([
      [ticketRef("1"), true],
      [ticketRef("2"), true],
    ]);
  });
});

describe("takeOnTogether sends a fixed number of statements", () => {
  // Each thing the Task links also gets a first-sight fact and its event: two
  // statements per thing that the facts ledger writes one at a time. They are
  // left out of the count, which is about the reads, the preparation and the links.
  it("sends as many statements for 24 things as for 4, apart from the facts and their events, whether it makes the Task or joins one", async () => {
    const count = (things: number, joins: boolean) =>
      run(({ service, tasks, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          const keys = Array.from({ length: things }, (_, index) => String(index));
          yield* report(
            connectionId,
            keys.map((key) => buildObservation(key)),
          );
          const ids = yield* Effect.forEach(keys, (key) => entityId(ticketRef(key)));
          if (joins) {
            yield* tasks.create({
              title: "Earlier",
              description: "",
              stage: "planned",
              provenance: [{ ref: ticketRef("0") }],
            });
          }
          const statements: Array<string> = [];
          const record = Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          );
          const result = yield* service.takeOnTogether({ ids, title: "Together" }).pipe(record);
          expect(result.created).toBe(!joins);
          return statements.filter(
            (text) => !text.includes("INTO events") && !text.includes("INTO task_entity_facts"),
          ).length;
        }),
      );
    expect(await count(24, false)).toBe(await count(4, false));
    expect(await count(24, true)).toBe(await count(4, true));
  });
});

describe("undoTakeOnTogether refuses a receipt that does not match the links", () => {
  /** A Task that links ticket 1 already; taking both tickets on together joins it and links ticket 2. */
  const joinEarlierTask = ({
    service,
    tasks,
    sql,
    report,
    connectionId,
    entityId,
  }: Parameters<Parameters<typeof run>[0]>[0]) =>
    Effect.gen(function* () {
      yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
      const ids = [yield* entityId(ticketRef("1")), yield* entityId(ticketRef("2"))] as const;
      const earlier = yield* tasks.create({
        title: "Earlier",
        description: "",
        stage: "planned",
        provenance: [{ ref: ticketRef("1") }],
      });
      const joined = yield* service.takeOnTogether({ ids: [...ids], title: "Unused" });
      return { ids, earlier, joined, sql };
    });

  it("never removes a link that an older call wrote, whatever `added` says", async () => {
    const { undone, links } = await run((context) =>
      Effect.gen(function* () {
        const { ids, earlier, joined, sql } = yield* joinEarlierTask(context);
        // Ticket 1 was linked before the call and only marked taken by it.
        const undone = yield* context.service.undoTakeOnTogether({
          ...joined,
          added: [ids[0], ids[1]],
        });
        return { undone, links: yield* readLinks(sql, earlier.id) };
      }),
    );
    expect(undone.undone).toBe(false);
    expect(links).toEqual([
      [ticketRef("1"), true],
      [ticketRef("2"), true],
    ]);
  });

  it("refuses a receipt whose `added` is not part of `taken`, and changes nothing", async () => {
    const { undone, links } = await run((context) =>
      Effect.gen(function* () {
        const { ids, earlier, joined, sql } = yield* joinEarlierTask(context);
        const undone = yield* context.service.undoTakeOnTogether({
          ...joined,
          added: [ids[1]],
          taken: [ids[0]],
        });
        return { undone, links: yield* readLinks(sql, earlier.id) };
      }),
    );
    expect(undone.undone).toBe(false);
    expect(links).toEqual([
      [ticketRef("1"), true],
      [ticketRef("2"), true],
    ]);
  });

  it("refuses a stale receipt: a link that is written again at another time is not the one it names", async () => {
    const { rewrittenWhole, rewrittenLinkOnly, links } = await run((context) =>
      Effect.gen(function* () {
        const { earlier, joined, sql } = yield* joinEarlierTask(context);
        const rewrite = (statement: Effect.Effect<unknown, unknown, never>) =>
          withTransaction(sql, statement);
        yield* rewrite(
          sql`UPDATE task_entity_links SET linked_at = '2030-01-01T00:00:00.000Z',
                taken_at = '2030-01-01T00:00:00.000Z'
              WHERE task_id = ${uuidFromString(earlier.id)} AND ref = ${ticketRef("2")}`,
        );
        const rewrittenWhole = yield* context.service.undoTakeOnTogether(joined);
        // The link is marked taken as the receipt says, but it was written at another time.
        yield* rewrite(
          sql`UPDATE task_entity_links SET taken_at = ${joined.takenAt}
              WHERE task_id = ${uuidFromString(earlier.id)} AND ref = ${ticketRef("2")}`,
        );
        const rewrittenLinkOnly = yield* context.service.undoTakeOnTogether(joined);
        return { rewrittenWhole, rewrittenLinkOnly, links: yield* readLinks(sql, earlier.id) };
      }),
    );
    expect(rewrittenWhole.undone).toBe(false);
    expect(rewrittenLinkOnly.undone).toBe(false);
    expect(links).toEqual([
      [ticketRef("1"), true],
      [ticketRef("2"), true],
    ]);
  });
});

describe("after a merge", () => {
  it("gives the survivor to a take-on, a read and the Inbox, and keeps the older link of a shared ref", async () => {
    const { before, after, taken, takenOther, inbox, links } = await run(
      ({ service, tasks, sql, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
          const one = yield* entityId(ticketRef("1"));
          const two = yield* entityId(ticketRef("2"));
          // The survivor is made first; the Task merged into it links both tickets, and links
          // ticket 1 earlier, so it is the active Task of both until the merge.
          const survivor = yield* tasks.create({
            title: "Survivor",
            description: "",
            provenance: [{ ref: ticketRef("1") }],
          });
          const source = yield* tasks.create({
            title: "Source",
            description: "",
            provenance: [{ ref: ticketRef("1") }, { ref: ticketRef("2") }],
          });
          yield* withTransaction(
            sql,
            sql`UPDATE task_entity_links SET linked_at = '2020-01-01T00:00:00.000Z', following = 1
                WHERE task_id = ${uuidFromString(source.id)} AND ref = ${ticketRef("1")}`,
          );
          const before = (yield* service.read(one)).taskId;
          yield* tasks.merge(source.id, { intoTaskId: survivor.id });
          return {
            before: { taskId: before, sourceId: source.id, survivorId: survivor.id },
            after: (yield* service.read(one)).taskId,
            taken: yield* service.takeOn(one),
            takenOther: yield* service.takeOn(two),
            inbox: (yield* readEverything(service)).things.map((card) => [card.ref, card.taskId]),
            links: yield* sql<{ readonly following: number; readonly linked_at: string }>`
              SELECT following, linked_at FROM task_entity_links
              WHERE task_id = ${uuidFromString(survivor.id)} AND ref = ${ticketRef("1")}`,
          };
        }),
    );
    expect(before.taskId).toBe(before.sourceId);
    expect(after).toBe(before.survivorId);
    expect(taken).toEqual({ taskId: before.survivorId, created: false });
    expect(takenOther).toEqual({ taskId: before.survivorId, created: false });
    expect(inbox).toEqual([
      [ticketRef("1"), before.survivorId],
      [ticketRef("2"), before.survivorId],
    ]);
    expect(links).toEqual([{ following: 1, linked_at: "2020-01-01T00:00:00.000Z" }]);
  });

  it("refuses to undo a take-on whose Task was merged, and says why", async () => {
    const { outcome, survivorLive } = await run(
      ({ service, tasks, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1")]);
          const id = yield* entityId(ticketRef("1"));
          const survivor = yield* tasks.create({ title: "Survivor", description: "" });
          const made = yield* service.takeOn(id);
          yield* tasks.merge(made.taskId, { intoTaskId: survivor.id });
          return {
            outcome: yield* service.undoTakeOn(id, made.taskId),
            survivorLive: (yield* tasks.read(survivor.id)).id === survivor.id,
          };
        }),
    );
    expect(outcome).toEqual({
      undone: false,
      reason: "The Task was merged into another Task, which now holds its work, so it stays.",
    });
    expect(survivorLive).toBe(true);
  });
});

describe("the summary of a Task that links an entity", () => {
  /** Takes ticket 1 on, then reports it again as `changed` says, and returns the summary's dirty revision before and after. */
  const reportAgain = (changed: Partial<FullEntityObservation>) =>
    run(({ service, report, connectionId, entityId, sql }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const made = yield* service.takeOn(yield* entityId(ticketRef("1")));
        const readRevision = Effect.map(
          sql<{ readonly dirty_revision: number }>`
            SELECT dirty_revision FROM task_summaries WHERE task_id = ${uuidFromString(made.taskId)}`,
          (rows) => rows[0]?.dirty_revision,
        );
        const before = yield* readRevision;
        yield* report(connectionId, [buildObservation("1", changed)]);
        return { before, after: yield* readRevision };
      }),
    );

  it.each([
    ["its title", { title: "A new title" }],
    ["its status", { status: "doing" as const }],
    ["its lifecycle", { lifecycle: "completed" as const }],
  ])("is marked dirty when a poll changes %s", async (_name, changed) => {
    const { before, after } = await reportAgain(changed);
    expect(after).toBe(before! + 1);
  });

  it("is left alone when a poll changes nothing the summary reads", async () => {
    const same = await reportAgain({});
    const other = await reportAgain({
      concerns: [],
      sourceUpdatedAt: "2026-03-02T00:00:00.000Z",
    });
    expect(same.after).toBe(same.before);
    expect(other.after).toBe(other.before);
  });
});

describe("dismiss and restore", () => {
  it("takes the card off the Inbox, stamped with the user, and brings it back", async () => {
    const { before, dismissed, dismissedBy, restored } = await run(
      ({ service, sql, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          yield* report(connectionId, [buildObservation("1")]);
          const id = yield* entityId(ticketRef("1"));
          const before = (yield* readEverything(service)).things.length;
          yield* service.dismiss({ ids: [id] });
          const rows = yield* sql<{ readonly dismissed_by: string }>`
            SELECT dismissed_by FROM external_entities WHERE id = ${uuidFromString(id)}`;
          const dismissed = yield* readEverything(service);
          yield* service.restore({ ids: [id] });
          return {
            before,
            dismissed: dismissed.things.length,
            dismissedBy: rows[0]?.dismissed_by,
            restored: (yield* readEverything(service)).things.length,
          };
        }),
    );
    expect({ before, dismissed, dismissedBy, restored }).toEqual({
      before: 1,
      dismissed: 0,
      dismissedBy: "user",
      restored: 1,
    });
  });

  it("fails NotFound for an unknown id, and refuses a session", async () => {
    const errors = await run(({ service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const id = yield* entityId(ticketRef("1"));
        return [
          yield* Effect.flip(service.dismiss({ ids: ["0199e0e7-9999-7000-8000-000000000000"] })),
          yield* Effect.flip(
            Effect.provideService(service.dismiss({ ids: [id] }), CurrentActor, A_SESSION),
          ),
          yield* Effect.flip(
            Effect.provideService(service.restore({ ids: [id] }), CurrentActor, A_SESSION),
          ),
        ];
      }),
    );
    expect(errors).toMatchObject([
      { error: { code: "not_found" } },
      { error: { code: "forbidden" } },
      { error: { code: "forbidden" } },
    ]);
  });
});

describe("search", () => {
  it("marks each result new, known or on Work, and reads it from the source", async () => {
    const reply = await run(({ script, service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("known"), buildObservation("onwork")]);
        yield* service.takeOn(yield* entityId(ticketRef("onwork")));
        script.search = () => ({
          observations: ["new", "known", "onwork"].map((key) => ({
            connectionId,
            observation: buildObservation(key, {
              repository: { target: { remote: "github.com/acme/web" } },
            }),
          })),
          incomplete: false,
          outcome: "results",
        });
        return yield* service.search({ source: "acme", text: "ticket" });
      }),
    );
    expect(reply.outcome).toBe("results");
    expect(reply.results.map((result) => [result.identifier, result.standing])).toEqual([
      ["NEW", "new"],
      ["KNOWN", "known"],
      ["ONWORK", "on-work"],
    ]);
    expect(reply.results[0]).toMatchObject({ location: "github.com/acme/web", noun: "Ticket" });
    expect(reply.results[2]!.taskId).toBeDefined();
  });

  it("changes the source for a pasted link, and says when no plugin reads it", async () => {
    const { link, unknown } = await run(({ script, service, connectionId }) =>
      Effect.gen(function* () {
        script.recognize = (text) =>
          text.startsWith("https://tracker.example/")
            ? [{ recognized: "ref", form: "url", ref: ticketRef("7"), kind: KIND }]
            : [];
        script.resolve = () => ({ found: { connectionId, observation: buildObservation("7") } });
        const link = yield* service.search({ source: "other", text: "https://tracker.example/7" });
        const unknown = yield* service.search({
          source: "acme",
          text: "https://elsewhere.example/7",
        });
        return { link, unknown };
      }),
    );
    expect(link).toMatchObject({ source: "acme", outcome: "results" });
    expect(link.results[0]!.ref).toBe(ticketRef("7"));
    expect(unknown).toMatchObject({ outcome: "unknown-link", linkSources: ["acme"], results: [] });
  });

  it("returns a link no account can open without a title", async () => {
    const reply = await run(({ script, service }) =>
      Effect.gen(function* () {
        script.recognize = () => [
          { recognized: "ref", form: "url", ref: ticketRef("7"), kind: KIND },
        ];
        script.resolve = () => ({ missing: "inaccessible" });
        return yield* service.search({ source: "acme", text: "https://tracker.example/7" });
      }),
    );
    expect(reply.outcome).toBe("inaccessible");
    expect(reply.results).toEqual([
      { ref: ticketRef("7"), kind: KIND, noun: "Ticket", standing: "new" },
    ]);
  });

  it("needs the user, and says when the source is unavailable", async () => {
    const { refused, unavailable } = await run(({ script, service }) =>
      Effect.gen(function* () {
        script.search = () => ({
          observations: [],
          incomplete: false,
          outcome: "source-unavailable",
        });
        return {
          refused: yield* Effect.flip(
            Effect.provideService(
              service.search({ source: "acme", text: "ticket" }),
              CurrentActor,
              A_SESSION,
            ),
          ),
          unavailable: yield* service.search({ source: "acme", text: "ticket" }),
        };
      }),
    );
    expect(refused).toMatchObject({ error: { code: "forbidden" } });
    expect(unavailable.outcome).toBe("source-unavailable");
  });
});

describe("listSuggestions", () => {
  it("lists a thing once under a chosen context, names its other contexts, and skips what has a Task", async () => {
    const { listed, others, afterTake, places } = await run(
      ({ service, report, connectionId, entityId }) =>
        Effect.gen(function* () {
          const place = (key: string): EntityObservation => ({
            kind: "project",
            ref: projectRef(key),
            title: `Project ${key}`,
            fields: { key },
            concerns: [],
            sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
          });
          const partOf = (...keys: ReadonlyArray<string>) => ({
            complete: true,
            partOf: keys.map(projectRef),
            linked: [],
          });
          yield* report(connectionId, [
            place("pricing"),
            place("checkout"),
            buildObservation("both", { relations: partOf("pricing", "checkout") }),
            buildObservation("only", { relations: partOf("checkout") }),
            buildObservation("loose"),
          ]);
          const inPricing = yield* service.listSuggestions({ contextRef: projectRef("pricing") });
          const inCheckout = yield* service.listSuggestions({ contextRef: projectRef("checkout") });
          yield* service.takeOn(yield* entityId(ticketRef("only")));
          return {
            listed: inPricing.suggestions.map((s) => [s.ref, s.alsoIn]),
            others: inCheckout.suggestions.map((s) => s.ref),
            afterTake: (yield* service.listSuggestions({
              contextRef: projectRef("checkout"),
            })).suggestions.map((s) => s.ref),
            places: inPricing.places.map((p) => p.ref),
          };
        }),
    );
    expect(listed).toEqual([[ticketRef("both"), [projectRef("checkout")]]]);
    expect(places).toEqual([projectRef("checkout")]);
    expect(others).toEqual([ticketRef("both"), ticketRef("only")]);
    expect(afterTake).toEqual([ticketRef("both")]);
  });

  it("lists everything that concerns the user when no context is chosen, and fails NotFound for an unknown one", async () => {
    const { all, error } = await run(({ service, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [
          buildObservation("1"),
          buildObservation("2", { concerns: [] }),
        ]);
        return {
          all: (yield* service.listSuggestions({})).suggestions.map((s) => s.ref),
          error: yield* Effect.flip(service.listSuggestions({ contextRef: projectRef("nowhere") })),
        };
      }),
    );
    expect(all).toEqual([ticketRef("1")]);
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("prune", () => {
  it("answers with what it deleted, and keeps what a Task links", async () => {
    const result = await run(({ service, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        yield* service.takeOn(yield* entityId(ticketRef("1")));
        return yield* service.prune();
      }),
    );
    expect(result).toEqual({ entities: 0, observations: 0 });
  });
});

describe("acting on a card that holds signals", () => {
  /** Writes an open signal raised from an event on the thread `threadRef`, and returns its id. */
  const raiseSignalOn = (connectionId: string, threadRef: string, number: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const signals = yield* signalRepository;
      const id = `0199e0e7-0005-7000-8000-${String(number).padStart(12, "0")}`;
      yield* withTransaction(
        sql,
        signals.insert(
          {
            id,
            kind: "acme/mentioned",
            origin: { type: "event", eventId: number, connectionId, threadRef },
            title: `Mention ${String(number)}`,
            priority: "normal",
            blocks: [],
            actions: [],
            match: {},
            status: "open",
            createdAt: "2026-03-01T00:00:00.000Z",
          },
          [],
        ),
      );
      return id;
    });

  const listOpenSignalIds = (sql: SqlClient.SqlClient) =>
    Effect.map(
      sql<{ readonly id: Uint8Array }>`SELECT id FROM signals WHERE status = 'open' ORDER BY id`,
      (rows) => rows.map((row) => uuidToString(row.id)),
    );

  it("ends no signal when the card is taken on, and the card keeps its signals", async () => {
    const found = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const first = yield* raiseSignalOn(connectionId, ticketRef("1"), 1);
        const second = yield* raiseSignalOn(connectionId, ticketRef("1"), 2);
        yield* service.takeOn(yield* entityId(ticketRef("1")));
        const inbox = yield* readEverything(service);
        return {
          expected: [first, second],
          open: yield* listOpenSignalIds(sql),
          card: inbox.things.find((candidate) => candidate.ref === ticketRef("1")),
        };
      }),
    );
    expect(found.open).toEqual(found.expected);
    expect(found.card).toHaveProperty("openKinds");
  });

  it("ends no signal when the card is dismissed, and a new signal leaves it dismissed", async () => {
    const found = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        yield* raiseSignalOn(connectionId, ticketRef("1"), 1);
        yield* service.dismiss({ ids: [yield* entityId(ticketRef("1"))] });
        yield* raiseSignalOn(connectionId, ticketRef("1"), 2);
        const inbox = yield* readEverything(service);
        return { open: (yield* listOpenSignalIds(sql)).length, cards: inbox.things.length };
      }),
    );
    expect(found).toEqual({ open: 2, cards: 0 });
  });
});

describe("link and unlink", () => {
  const UNREAD = ticketRef("never-read");

  it("links to a ref nobody has read, as the user's claim, and the next refresh asks for it", async () => {
    const { claims, wanted } = await run(({ service, sql, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        yield* service.link({ fromRef: ticketRef("1"), toRef: UNREAD });
        const claims = yield* sql<{
          readonly from_ref: string;
          readonly to_ref: string;
          readonly claim_type: string;
          readonly actor: string | null;
          readonly connection_id: Uint8Array | null;
        }>`SELECT from_ref, to_ref, claim_type, actor, connection_id
           FROM external_entity_relation_claims`;
        const entities = yield* externalEntityRepository;
        const wanted = yield* withTransaction(
          sql,
          entities.listWanted({
            connectionId,
            refPrefix: "acme:ticket:",
            limit: 10,
            now: new Date().toISOString(),
            includesSignalRefs: false,
          }),
        );
        return { claims, wanted };
      }),
    );

    expect(claims).toEqual([
      {
        from_ref: ticketRef("1"),
        to_ref: UNREAD,
        claim_type: "person",
        actor: "user",
        connection_id: null,
      },
    ]);
    expect(wanted).toContain(UNREAD);
  });

  it("writes no timeline row: a person's own link is not news from outside", async () => {
    const rows = await run(({ service, sql, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        yield* service.link({ fromRef: ticketRef("1"), toRef: ticketRef("2") });
        const timeline = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM external_entity_timeline`;
        return timeline[0]!.n;
      }),
    );

    expect(rows).toBe(0);
  });

  it("writes one claim for a pair however often and from whichever side it is linked", async () => {
    const count = await run(({ service, sql, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        const first = yield* service.link({ fromRef: ticketRef("1"), toRef: ticketRef("2") });
        const again = yield* service.link({ fromRef: ticketRef("1"), toRef: ticketRef("2") });
        const reversed = yield* service.link({ fromRef: ticketRef("2"), toRef: ticketRef("1") });
        const rows = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM external_entity_relation_claims`;
        return { count: rows[0]!.n, created: [first, again, reversed].map((r) => r.created) };
      }),
    );

    expect(count).toEqual({ count: 1, created: [true, false, false] });
  });

  it("removes only the person's claim, in either direction, and says what a source's claim leaves", async () => {
    const result = await run(({ service, sql, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [
          buildObservation("1", {
            relations: { complete: true, partOf: [], linked: [ticketRef("2")] },
          }),
          buildObservation("2"),
        ]);
        yield* service.link({ fromRef: ticketRef("2"), toRef: ticketRef("1") });
        const removed = yield* service.unlink({ fromRef: ticketRef("1"), toRef: ticketRef("2") });
        const again = yield* service.unlink({ fromRef: ticketRef("1"), toRef: ticketRef("2") });
        const left = yield* sql<{ readonly claim_type: string }>`
          SELECT claim_type FROM external_entity_relation_claims`;
        return { removed, again, left: left.map((row) => row.claim_type) };
      }),
    );

    expect(result.removed).toEqual({ removed: true, remaining: "source" });
    expect(result.again).toEqual({ removed: false, remaining: "source" });
    expect(result.left).toEqual(["source"]);
  });

  it("refuses a session, a link to itself, and a ref that is not one; and a thing Hercule never saw", async () => {
    const errors = await run(({ service, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const input = { fromRef: ticketRef("1"), toRef: UNREAD };
        return [
          yield* Effect.flip(Effect.provideService(service.link(input), CurrentActor, A_SESSION)),
          yield* Effect.flip(Effect.provideService(service.unlink(input), CurrentActor, A_SESSION)),
          yield* Effect.flip(service.link({ fromRef: ticketRef("1"), toRef: ticketRef("1") })),
          yield* Effect.flip(
            service.link({ fromRef: ticketRef("1"), toRef: "unresolved:url:https://x.test" }),
          ),
          yield* Effect.flip(service.link({ fromRef: UNREAD, toRef: ticketRef("1") })),
        ];
      }),
    );

    expect(errors).toMatchObject([
      { error: { code: "forbidden" } },
      { error: { code: "forbidden" } },
      { error: { code: "invalid_state" } },
      { error: { code: "invalid_state" } },
      { error: { code: "not_found" } },
    ]);
  });
});

const WEB = "github.com/acme/web";
const API = "github.com/acme/api";

/** Inserts a stored workflow that takes an `acme/ticket` and an `acme/acme` account, and returns its id. */
const insertWorkflow = (
  sql: SqlClient.SqlClient,
  name: string,
  options: {
    readonly workspace?: unknown;
    readonly enabled?: boolean;
    readonly invalid?: boolean;
    readonly kinds?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const id = uuidToString(mintUuid());
    const definition = {
      name,
      inputs: [
        { name: "ticket", entity: { kinds: options.kinds ?? [KIND] }, required: true },
        { name: "account", connection: { type: "acme/acme" }, required: true },
      ],
      steps: [],
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    };
    const at = new Date().toISOString();
    yield* withTransaction(
      sql,
      sql`
        INSERT INTO workflows (id, source, definition, enabled, invalid_since, created_at, updated_at)
        VALUES (${uuidFromString(id)}, '', ${JSON.stringify(definition)},
                ${options.enabled === false ? 0 : 1}, ${options.invalid === true ? at : null},
                ${at}, ${at})`,
    );
    return id;
  });

/** Inserts a repo Resource with this canonical remote, and returns its id. */
const insertRepo = (sql: SqlClient.SqlClient, canonicalRemote: string) =>
  Effect.gen(function* () {
    const id = uuidToString(mintUuid());
    const at = new Date().toISOString();
    yield* withTransaction(
      sql,
      sql`
        INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
        VALUES (${uuidFromString(id)}, 'repo', ${`https://${canonicalRemote}`}, ${canonicalRemote}, 1,
                ${at}, ${at})`,
    );
    return id;
  });

describe("what a card offers", () => {
  it("gives cards of one kind and repository one offer set, and each card its own accounts", async () => {
    const result = await run(({ service, sql, report, connectionId, insertAccount, entityId }) =>
      Effect.gen(function* () {
        const second = yield* insertAccount("acme-2");
        yield* report(connectionId, [buildObservation("1"), buildObservation("2")]);
        yield* report(second, [buildObservation("1")]);
        const review = yield* insertWorkflow(sql, "Review");
        yield* insertWorkflow(sql, "Disabled", { enabled: false });
        yield* insertWorkflow(sql, "Invalid", { invalid: true });
        yield* insertWorkflow(sql, "Other kind", { kinds: ["acme/epic"] });
        const inbox = yield* readEverything(service);
        const detail = yield* service.read(yield* entityId(ticketRef("1")));
        return { review, inbox, detail, second };
      }),
    );
    const [first, other] = result.inbox.things;
    expect(first!.offerSetId).toBe(other!.offerSetId);
    expect(result.inbox.offerSets).toEqual({
      [first!.offerSetId]: [
        {
          workflowId: result.review,
          name: "Review",
          answers: [],
          connectionInputName: "account",
        },
      ],
    });
    expect(first!.actingConnections.map((account) => account.label)).toEqual(["acme-1", "acme-2"]);
    expect(other!.actingConnections.map((account) => account.label)).toEqual(["acme-1"]);
    expect(result.detail.offers).toEqual(result.inbox.offerSets[first!.offerSetId]);
    expect(result.detail.actingConnections).toEqual(first!.actingConnections);
  });

  it("splits offer sets by the repository the work lands in, and a fork compares its target", async () => {
    const result = await run(({ service, sql, report, connectionId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [
          buildObservation("web", { repository: { target: { remote: WEB } } }),
          buildObservation("api", { repository: { target: { remote: API } } }),
          buildObservation("fork", {
            repository: {
              target: { remote: WEB },
              head: { remote: "github.com/someone/web", branch: "fix" },
            },
          }),
        ]);
        const webOnly = yield* insertWorkflow(sql, "Web only", {
          workspace: { kind: "primary", resourceId: yield* insertRepo(sql, WEB) },
        });
        const inbox = yield* readEverything(service);
        const setOf = (key: string) =>
          inbox.things.find((card) => card.ref === ticketRef(key))!.offerSetId;
        return { webOnly, inbox, setOf };
      }),
    );
    const { inbox, setOf } = result;
    expect(setOf("web")).toBe(setOf("fork"));
    expect(setOf("api")).not.toBe(setOf("web"));
    expect(inbox.offerSets[setOf("web")]![0]!.unavailable).toBeUndefined();
    expect(inbox.offerSets[setOf("api")]![0]!.unavailable).toEqual({
      reason: "repository",
      message: "Web only works on acme/web only",
    });
  });

  it("offers a workflow with a fixed repository on a kind that has none", async () => {
    const offers = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        yield* insertWorkflow(sql, "Web only", {
          workspace: { kind: "primary", resourceId: yield* insertRepo(sql, WEB) },
        });
        return (yield* service.read(yield* entityId(ticketRef("1")))).offers;
      }),
    );
    expect(offers.map((offer) => offer.unavailable)).toEqual([undefined]);
  });

  it("offers a workflow whose workspace names only a folder on a thing with a repository", async () => {
    const offers = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [
          buildObservation("1", { repository: { target: { remote: API } } }),
        ]);
        const folder = uuidToString(mintUuid());
        const at = new Date().toISOString();
        yield* withTransaction(
          sql,
          sql`INSERT INTO resources (id, kind, workspace_include, created_at, updated_at)
              VALUES (${uuidFromString(folder)}, 'folder', 0, ${at}, ${at})`,
        );
        yield* insertWorkflow(sql, "Notes", { workspace: { kind: "primary", resourceId: folder } });
        return (yield* service.read(yield* entityId(ticketRef("1")))).offers;
      }),
    );
    expect(offers.map((offer) => offer.unavailable)).toEqual([undefined]);
  });

  it("says no account can act when the only Connection is disabled", async () => {
    const detail = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        yield* insertWorkflow(sql, "Review");
        yield* withTransaction(sql, sql`UPDATE connections SET status = 'disabled'`);
        return yield* service.read(yield* entityId(ticketRef("1")));
      }),
    );
    expect(detail.actingConnections).toEqual([]);
    expect(detail.offers.map((offer) => offer.unavailable)).toEqual([
      { reason: "no-account", message: "No connected account can act on this" },
    ]);
  });

  it("cuts the accounts of a card to the bound, while the handoff still sees every account", async () => {
    const result = await run(({ service, sql, report, connectionId, insertAccount, entityId }) =>
      Effect.gen(function* () {
        const entities = yield* externalEntityRepository;
        const ids = [connectionId];
        for (let index = 2; index <= MAX_ACTING_CONNECTIONS + 1; index++) {
          ids.push(yield* insertAccount(`acme-${String(index)}`));
        }
        for (const id of ids) yield* report(id, [buildObservation("1")]);
        const review = yield* insertWorkflow(sql, "Review");
        const detail = yield* service.read(yield* entityId(ticketRef("1")));
        const target = { ref: ticketRef("1"), kind: KIND, targetRemote: undefined };
        const kind = { kind: KIND, connectionType: "acme/acme", signalKinds: [] };
        const shown = new Set(detail.actingConnections.map((account) => account.id));
        const cutOff = ids.filter((id) => !shown.has(id));
        return {
          detail,
          cutOff,
          chosen: yield* entities.prepareHandoff(target, review, cutOff[0], kind),
        };
      }),
    );
    expect(result.detail.actingConnections).toHaveLength(MAX_ACTING_CONNECTIONS);
    expect(result.cutOff).toHaveLength(1);
    expect(result.chosen).toMatchObject({
      _tag: "Accepted",
      offer: result.detail.offers[0],
      connection: { id: result.cutOff[0] },
    });
  });

  it("decides a handoff from one read: the offer by the menu's rules, and the account that acts or the words that refuse", async () => {
    const outcomes = await run(({ sql, report, connectionId, insertAccount }) =>
      Effect.gen(function* () {
        const entities = yield* externalEntityRepository;
        const second = yield* insertAccount("acme-2");
        const bystander = yield* insertAccount("acme-3");
        const observation = buildObservation("1", { repository: { target: { remote: API } } });
        yield* report(connectionId, [observation]);
        yield* report(second, [observation]);
        const workflowIds = {
          review: yield* insertWorkflow(sql, "Review"),
          webOnly: yield* insertWorkflow(sql, "Web only", {
            workspace: { kind: "primary", resourceId: yield* insertRepo(sql, WEB) },
          }),
          disabled: yield* insertWorkflow(sql, "Disabled", { enabled: false }),
          invalid: yield* insertWorkflow(sql, "Invalid", { invalid: true }),
          unknown: uuidToString(mintUuid()),
        };
        const accountIds = { oldest: connectionId, second, bystander };
        const target = { ref: ticketRef("1"), kind: KIND, targetRemote: API };
        const kind = { kind: KIND, connectionType: "acme/acme", signalKinds: [] };
        const decide = (
          workflow: keyof typeof workflowIds,
          account: keyof typeof accountIds | undefined,
          plugin: "running" | "stopped" = "running",
        ) =>
          Effect.map(
            entities.prepareHandoff(
              target,
              workflowIds[workflow],
              account === undefined ? undefined : accountIds[account],
              plugin === "running" ? kind : undefined,
            ),
            (prepared) =>
              prepared._tag === "Accepted"
                ? `${prepared.offer.name} by ${prepared.connection.label}`
                : prepared.words,
          );
        return [
          yield* decide("review", undefined),
          yield* decide("review", "second"),
          yield* decide("review", "bystander"),
          yield* decide("webOnly", undefined),
          yield* decide("disabled", undefined),
          yield* decide("invalid", undefined),
          yield* decide("unknown", undefined),
          yield* decide("review", undefined, "stopped"),
        ];
      }),
    );
    expect(outcomes).toEqual([
      "Review by acme-1",
      "Review by acme-2",
      "That account cannot act on this. Choose another account.",
      "Web only works on acme/web only",
      "That workflow cannot take this. Reload the Inbox and choose again.",
      "That workflow cannot take this. Reload the Inbox and choose again.",
      "That workflow cannot take this. Reload the Inbox and choose again.",
      "Review needs account, which a card cannot fill",
    ]);
  });
});

describe("what a card shows of the live work on its Task", () => {
  /** Inserts a run of a workflow on a Task, live or finished, created `minute` minutes into the hour. */
  const insertRun = (
    sql: SqlClient.SqlClient,
    run: {
      readonly taskId: string;
      readonly workflowId: string;
      readonly name: string;
      readonly status: "pending" | "running" | "completed";
      readonly minute: number;
    },
  ) => {
    const at = `2026-03-01T00:${String(run.minute).padStart(2, "0")}:00.000Z`;
    return withTransaction(
      sql,
      sql`
        INSERT INTO runs (id, workflow_id, plan, inputs, origin, status, created_at, finished_at, task_id)
        VALUES (${uuidFromString(uuidToString(mintUuid()))}, ${uuidFromString(run.workflowId)},
                ${JSON.stringify({ name: run.name })}, '{}', '{"kind":"manual","actor":"user"}',
                ${run.status}, ${at}, ${run.status === "completed" ? at : null},
                ${uuidFromString(run.taskId)})`,
    );
  };

  it("names each workflow with a live run on the card's Task once, newest run first, and no finished one", async () => {
    const cards = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [
          buildObservation("1"),
          buildObservation("2"),
          buildObservation("3"),
        ]);
        const taken = yield* service.takeOn(yield* entityId(ticketRef("1")));
        const finishedOnly = yield* service.takeOn(yield* entityId(ticketRef("2")));
        const review = yield* insertWorkflow(sql, "Review");
        const plan = yield* insertWorkflow(sql, "Plan");
        const ship = yield* insertWorkflow(sql, "Ship");
        const on =
          (taskId: string, workflowId: string, name: string) =>
          (status: "pending" | "running" | "completed", minute: number) =>
            insertRun(sql, { taskId, workflowId, name, status, minute });
        yield* on(taken.taskId, review, "Review")("pending", 1);
        yield* on(taken.taskId, plan, "Plan")("running", 2);
        yield* on(taken.taskId, ship, "Ship")("completed", 3);
        yield* on(taken.taskId, review, "Review")("running", 4);
        yield* on(finishedOnly.taskId, ship, "Ship")("completed", 5);
        const inbox = yield* readEverything(service);
        return {
          ids: { review, plan },
          things: inbox.things.map((card) => [card.ref, card.liveWorkflows] as const),
        };
      }),
    );
    expect(cards.things).toEqual([
      [
        ticketRef("1"),
        [
          { workflowId: cards.ids.review, name: "Review" },
          { workflowId: cards.ids.plan, name: "Plan" },
        ],
      ],
      [ticketRef("2"), []],
      [ticketRef("3"), []],
    ]);
  });

  it("cuts the workflows of a card to the bound, keeping the newest runs", async () => {
    const live = await run(({ service, sql, report, connectionId, entityId }) =>
      Effect.gen(function* () {
        yield* report(connectionId, [buildObservation("1")]);
        const taken = yield* service.takeOn(yield* entityId(ticketRef("1")));
        for (let index = 1; index <= MAX_LIVE_WORKFLOWS + 1; index++) {
          const name = `Workflow ${String(index)}`;
          yield* insertRun(sql, {
            taskId: taken.taskId,
            workflowId: yield* insertWorkflow(sql, name),
            name,
            status: "running",
            minute: index,
          });
        }
        return (yield* readEverything(service)).things[0]!.liveWorkflows;
      }),
    );
    expect(live.map((workflow) => workflow.name)).toEqual(
      Array.from(
        { length: MAX_LIVE_WORKFLOWS },
        (_, index) => `Workflow ${String(MAX_LIVE_WORKFLOWS + 1 - index)}`,
      ),
    );
  });
});
