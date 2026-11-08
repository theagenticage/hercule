/**
 * Test helpers for the handoff of an External Entity, driven over HTTP
 * against a real controller: an invented tracker plugin (northwind) with a
 * Connection type, two entity kinds and a reply action, and functions that
 * arrange the rows a handoff reads (accounts, things, signals, workflows).
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  registerWorkflowAction,
  type EntityKindDeclaration,
  type Plugin,
} from "@hercule/plugin-host";
import type { EntityHandOffResult, Run, Signal } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { get, post } from "../http/testing";
import { IDLE_FEEDS, IDLE_INGEST_OPEN } from "../plugins/testing";
import { signalRepository } from "../signals/repository";
import {
  createConnection,
  createWorkflowOrFail,
  updateWorkflow,
  withSetUpController,
  type SetUpController,
} from "../workflows/testing";

export const NORTHWIND_CONNECTION_TYPE = "northwind/northwind";
export const REPLY_ACTION_ID = "northwind/reply.post";

/** A thing with a repository: the kind of work a pull request is. */
export const CHANGE_KIND = "northwind/change";
/** A thing with no repository: the kind of work a ticket is. */
export const TICKET_KIND = "northwind/ticket";

export const REVIEW_REQUESTED = "northwind/review-requested";
export const MENTIONED = "northwind/mentioned";

/** The canonical remote of the repository the changes of the tests land in. */
export const REMOTE = "github.com/northwind/web";

const buildKind = (word: string, noun: string): EntityKindDeclaration => ({
  word,
  noun,
  refPrefix: `northwind:${word}:`,
  pace: "fast",
  card: "compact",
  patience: 24,
  identifier: "{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
});

/** The northwind plugin, and every reply its action was asked to post. */
export interface Northwind {
  readonly plugin: Plugin;
  readonly replies: Array<unknown>;
}

/**
 * Builds the northwind plugin. When `replyHeldUntil` is given, a reply waits
 * for it after recording its call, so a test can hold a plugin answer open.
 */
export const buildNorthwind = (replyHeldUntil?: Promise<void>): Northwind => {
  const replies: Array<unknown> = [];
  const plugin: Plugin = {
    manifest: {
      id: "northwind",
      displayName: "Northwind",
      hostApi: HOST_API,
      capabilities: ["connections", "event-sources", "events", "entities", "workflow-actions"],
      configSchema: Schema.Struct({}),
    },
    register: (host) =>
      registerConnectionType(host, {
        type: "northwind",
        displayName: "Northwind",
        setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
        validate: (credentials: Record<string, string>) =>
          Effect.succeed({ displayName: "bot", accountId: credentials["token"] ?? "none" }),
      }).pipe(
        Effect.andThen(
          registerEventSource(host, {
            id: "northwind",
            connectionType: NORTHWIND_CONNECTION_TYPE,
            feeds: IDLE_FEEDS,
            open: IDLE_INGEST_OPEN,
            entityKinds: [buildKind("change", "Change"), buildKind("ticket", "Ticket")],
            kinds: {
              "northwind.thing.done": {
                description: "Something was done.",
                schema: Schema.Struct({ title: Schema.String }),
                availableToTriage: true,
              },
            },
          }),
        ),
        Effect.andThen(
          registerWorkflowAction(host, {
            id: "reply.post",
            displayName: "Post a reply",
            description: "Posts a reply on a change.",
            connection: { type: NORTHWIND_CONNECTION_TYPE },
            input: Schema.Struct({ body: Schema.String }),
            output: Schema.Struct({ posted: Schema.Boolean }),
            usableIn: ["workflow.step", "signal.answer"],
            describe: () => [{ kind: "text", text: "Post a reply" }],
            outcome: () => "Replied",
            execute: (input) =>
              Effect.sync(() => replies.push(input)).pipe(
                Effect.andThen(
                  replyHeldUntil === undefined ? Effect.void : Effect.promise(() => replyHeldUntil),
                ),
                Effect.as({ posted: true }),
              ),
          }),
        ),
      ),
    activate: () => Effect.succeed(Effect.void),
  };
  return { plugin, replies };
};

/** Runs `body` against a set-up controller that runs the northwind plugin. */
export const withNorthwind = (
  body: (controller: SetUpController, northwind: Northwind) => Promise<void>,
  replyHeldUntil?: Promise<void>,
): Promise<void> => {
  const northwind = buildNorthwind(replyHeldUntil);
  return withSetUpController((controller) => body(controller, northwind), [northwind.plugin]);
};

/** Runs an effect that needs the controller's database, and fails the test on any error. */
const runOnDatabase = <A, E>(
  { harness }: SetUpController,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.orDie(effect.pipe(Effect.provideService(SqlClient.SqlClient, harness.sql))),
  );

/** Creates an account: a northwind Connection with its own token. Returns its id. */
export const createAccount = (controller: SetUpController, name: string): Promise<string> =>
  createConnection(controller.base, controller.token, NORTHWIND_CONNECTION_TYPE, { token: name });

/** A thing the tests arranged: its id and its ref. */
export interface Thing {
  readonly id: string;
  readonly ref: string;
}

/**
 * Writes the record of a thing and, for each account, an observation of it
 * that can read it. A `change` lands in the repository `REMOTE`; a `ticket`
 * has none.
 */
export const arrangeThing = (
  controller: SetUpController,
  fields: {
    readonly kind: typeof CHANGE_KIND | typeof TICKET_KIND;
    readonly key: string;
    readonly title: string;
    readonly accounts: ReadonlyArray<string>;
  },
): Promise<Thing> => {
  const word = fields.kind.slice(fields.kind.indexOf("/") + 1);
  const ref = `northwind:${word}:${fields.key}`;
  const id = uuidToString(mintUuid());
  const now = new Date().toISOString();
  const repository =
    fields.kind === CHANGE_KIND ? JSON.stringify({ target: { remote: REMOTE } }) : null;
  return runOnDatabase(
    controller,
    withTransaction(
      controller.harness.sql,
      Effect.gen(function* () {
        const sql = controller.harness.sql;
        yield* sql`
          INSERT INTO external_entities
            (id, ref, kind, noun, pace, completeness, identifier, title, repository, first_observed_at, updated_at)
          VALUES (${uuidFromString(id)}, ${ref}, ${fields.kind}, ${word}, 'fast', 'full',
                  ${fields.key}, ${fields.title}, ${repository}, ${now}, ${now})`;
        for (const account of fields.accounts) {
          yield* sql`
            INSERT INTO external_entity_observations (ref, connection_id)
            VALUES (${ref}, ${uuidFromString(account)})`;
        }
      }),
    ),
  ).then(() => ({ id, ref }));
};

/** What `insertSignal` needs to write an open signal on a thing. */
export interface SignalFields {
  readonly thing: Thing;
  readonly kind: string;
  readonly connectionId: string;
  /** Gives the signal a reply action with this body. */
  readonly replyBody?: string;
  /** The values an Ignore Rule would match the signal by. Signals with the same values are one group. */
  readonly match?: Readonly<Record<string, string>>;
  /** Gives the signal a Hand to an agent action for each of these workflows, as Intake does. */
  readonly handOffTo?: ReadonlyArray<string>;
}

/**
 * Builds the write of an open signal of `kind` on the thing, raised by
 * `connectionId`; it returns the signal's id. No operation raises a plugin's
 * signal without a running source, so the row is written through the
 * repository the event pipeline uses. Run it in a transaction.
 */
export const insertSignal = (fields: SignalFields) =>
  Effect.gen(function* () {
    const id = uuidToString(mintUuid());
    const signals = yield* signalRepository;
    yield* signals.insert(
      {
        id,
        kind: fields.kind,
        origin: {
          type: "event",
          eventId: 1,
          connectionId: fields.connectionId,
          threadRef: fields.thing.ref,
        },
        title: `${fields.kind} on ${fields.thing.ref}`,
        place: "northwind/web",
        priority: "normal",
        blocks: [],
        actions: [
          ...(fields.replyBody === undefined
            ? []
            : [
                {
                  id: "reply",
                  label: "Reply",
                  operation: {
                    op: REPLY_ACTION_ID,
                    connectionId: fields.connectionId,
                    input: { body: fields.replyBody },
                  },
                },
              ]),
          ...(fields.handOffTo ?? []).map((workflowId) => ({
            id: `hand-to-${workflowId}`,
            label: "Hand to an agent",
            operation: { op: "signal.handOff" as const, input: { signalId: id, workflowId } },
          })),
        ],
        match: fields.match ?? {},
        status: "open",
        createdAt: new Date().toISOString(),
      },
      [],
    );
    return id;
  });

/** Writes an open signal on the thing (see `insertSignal`) and returns its id. */
export const arrangeSignal = (controller: SetUpController, fields: SignalFields): Promise<string> =>
  runOnDatabase(controller, withTransaction(controller.harness.sql, insertSignal(fields)));

/** The inputs of the workflow `createHandoffWorkflow` makes. */
export interface HandoffWorkflowOptions {
  readonly name: string;
  readonly kinds?: ReadonlyArray<string>;
  /** The signal kinds the workflow answers. */
  readonly answers?: ReadonlyArray<string>;
  /** Adds a required `connection` input, which the core fills with the acting account. */
  readonly withAccount?: boolean;
  /**
   * Adds a `signal` input for these kinds, so Intake can hand a signal to the
   * workflow too. Both the `signal` and the `entity` input are then optional,
   * because each way of starting fills only one of them.
   */
  readonly signalKinds?: ReadonlyArray<string>;
  /** Replaces the default step, a wait of a minute that keeps the run alive for the whole test. */
  readonly steps?: ReadonlyArray<object>;
  readonly workspace?: object;
}

const HOLD_STEP = {
  id: "hold",
  kind: "action",
  action: "wait",
  params: { seconds: 60 },
};

/** Creates and enables a workflow with an `entity` input called `item`. Returns its id. */
export const createHandoffWorkflow = async (
  { base, token }: SetUpController,
  options: HandoffWorkflowOptions,
): Promise<string> => {
  const workflow = await createWorkflowOrFail(base, token, {
    definition: {
      name: options.name,
      inputs: [
        {
          name: "item",
          entity: {
            kinds: options.kinds ?? [CHANGE_KIND],
            ...(options.answers === undefined ? {} : { answers: options.answers }),
          },
          required: options.signalKinds === undefined,
        },
        ...(options.signalKinds === undefined
          ? []
          : [{ name: "signal", signal: { kinds: options.signalKinds }, required: false }]),
        ...(options.withAccount === true
          ? [{ name: "account", connection: { type: NORTHWIND_CONNECTION_TYPE }, required: true }]
          : []),
      ],
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      steps: options.steps ?? [HOLD_STEP],
    },
  });
  const enabled = await updateWorkflow(base, token, workflow.id, { enabled: true });
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  return workflow.id;
};

/** Hands a thing to a workflow over HTTP and returns the response. */
export const requestHandOff = (
  { base, token }: SetUpController,
  thing: Thing,
  body: { readonly workflowId: string; readonly connectionId?: string },
): Promise<Response> => post(base, `/api/v1/external-entities/${thing.id}/hand-off`, body, token);

/** Hands a thing to a workflow and returns the run and Task, or fails the test. */
export const handOff = async (
  controller: SetUpController,
  thing: Thing,
  body: { readonly workflowId: string; readonly connectionId?: string },
): Promise<EntityHandOffResult> => {
  const response = await requestHandOff(controller, thing, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as EntityHandOffResult;
};

/** Takes a handoff back over HTTP and returns the response. */
export const requestUndoHandOff = ({ base, token }: SetUpController, runId: string) =>
  post(base, `/api/v1/external-entities/handoffs/${runId}/undo`, {}, token);

/** Reads a signal over HTTP. */
export const readSignal = async ({ base, token }: SetUpController, id: string): Promise<Signal> => {
  const response = await get(base, `/api/v1/signals/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

/** Counts the rows of a table, for the tests that check a refusal wrote nothing. */
export const countRows = (
  controller: SetUpController,
  table: "tasks" | "runs" | "entity_handoffs" | "signals",
): Promise<number> =>
  runOnDatabase(
    controller,
    Effect.map(
      controller.harness.sql<{
        readonly n: number;
      }>`SELECT count(*) AS n FROM ${controller.harness.sql(table)}`,
      (rows) => rows[0]!.n,
    ),
  );

/**
 * Waits until the run's engine has started the run's step. The step the
 * tests use waits a minute, so after this the engine writes nothing more
 * about the run for the rest of the test.
 */
export const waitForStepToRun = async (
  { base, token }: SetUpController,
  runId: string,
): Promise<void> => {
  await expect
    .poll(async () => {
      const response = await get(base, `/api/v1/runs/${runId}`, token);
      const run = (await response.json()) as Run;
      return run.steps.some((record) => record.status === "running");
    })
    .toBe(true);
};

/**
 * Puts the run's step records back to `pending`. The engine starts a run a
 * moment after its request, too soon for a test to undo in between, so a test
 * that needs "nothing was dispatched yet" waits for the engine to settle (see
 * `waitForStepToRun`) and then writes the rows a run has before the engine
 * picks it up.
 */
export const rewindRunToPending = async (
  controller: SetUpController,
  runId: string,
): Promise<void> => {
  await waitForStepToRun(controller, runId);
  await runOnDatabase(
    controller,
    withTransaction(
      controller.harness.sql,
      controller.harness.sql`
        UPDATE run_steps SET status = 'pending', started_at = NULL, finished_at = NULL,
                             output = NULL, error = NULL
        WHERE run_id = ${uuidFromString(runId)}`,
    ),
  );
};

/**
 * Writes a Thread (a session row) on the Task, of the run `runId` when one is
 * given. Nothing starts: the row is all the Undo looks at.
 */
export const insertThread = (
  controller: SetUpController,
  taskId: string,
  runId?: string,
): Promise<void> => {
  const runner = mintUuid();
  const at = new Date().toISOString();
  const sql = controller.harness.sql;
  return runOnDatabase(
    controller,
    withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
                   VALUES (${runner}, ${uuidToString(runner)}, 'online', 'active', 0, '[]', ${uuidToString(runner)}, ${at}, ${at})`;
        yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at, task_id, run_id, step_id)
                   VALUES (${mintUuid()}, ${mintUuid()}, ${mintUuid()}, ${runner}, 'default', 'default',
                           '{}', 'thread', 'idle', ${at}, ${at}, ${uuidFromString(taskId)},
                           ${runId === undefined ? null : uuidFromString(runId)},
                           ${runId === undefined ? null : "hold"})`;
      }),
    ),
  ).then(() => undefined);
};
