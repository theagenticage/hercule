/**
 * Tests the signal service against a migrated in-memory database, with the
 * fake `BoundOperations` port: who may raise, act on, withdraw, mark done,
 * snooze and lower a signal, the actions the core lays out beside the
 * raiser's, how each view filters and pages, and what each write records in
 * the audit log, and the Ignore Rule the core offers after a streak of Done.
 *
 * What an operation really does when the user takes an action, a plugin
 * action with a typed reply, and the real describe lines are tested over
 * HTTP in `signals.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import {
  decodeAnswerOperation,
  DONE_ACTION_ID,
  isQualifiedId,
  MAX_BOUND_INPUT_BYTES,
  MAX_SIGNAL_MATCH_VALUE_LENGTH,
  type BoundAction,
  type Grant,
  type Signal,
  type SignalMatch,
  type SignalRaiseInput,
  type SignalResolution,
  type WorkflowDefinition,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { BoundOperations } from "../bound-actions";
import { FakeBoundOperationsLayer } from "../bound-actions/testing";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { PluginHost, type RegisteredSignalKind } from "../plugins";
import { workflowRepository } from "../workflows";
import { ignoreRuleRepository } from "./ignore-rule-repository";
import {
  IgnoreRuleService,
  IgnoreRuleServiceLayer,
  signalRepository,
  SignalClaimsLayer,
  SignalService,
  SignalServiceLayer,
} from "./index";

type Deps = SignalService | IgnoreRuleService | SqlClient.SqlClient;

/** The signal kind of the one plugin the stub host knows. */
const PLUGIN_KIND = "acme/asked";

/**
 * A plugin host that knows one signal kind, of the plugin Acme, with two
 * match fields. The signal service reads the host to name the plugin in a
 * Done's describe line and to word its Ignore Rule offer; the Ignore Rule
 * service reads it to check a new rule.
 */
const PluginHostStub = Layer.mock(PluginHost)({
  findSignalKind: (kind) =>
    Effect.succeed(
      kind === PLUGIN_KIND
        ? Option.some({
            kind,
            pluginId: "acme",
            pluginDisplayName: "Acme",
            label: "Question asked",
            matchFields: [
              { name: "repo", label: "Repository", path: "event.payload.repo" },
              { name: "author", label: "Author", path: "event.payload.author" },
            ],
          } as unknown as RegisteredSignalKind)
        : Option.none(),
    ),
});

/**
 * The fake `BoundOperations` port, except that `ignoreRule.create` really
 * creates the rule, so taking Ignore on the core's offer can be tested here.
 */
const IgnoreRuleCreatingOperationsLayer = Layer.effect(BoundOperations)(
  Effect.gen(function* () {
    const fake = yield* BoundOperations;
    const ignoreRules = yield* IgnoreRuleService;
    return BoundOperations.of({
      ...fake,
      run: (operation) =>
        operation.op === "ignoreRule.create"
          ? Effect.asVoid(ignoreRules.create(operation.input))
          : fake.run(operation),
    });
  }),
).pipe(Layer.provide(FakeBoundOperationsLayer));

/**
 * The signal service and the Ignore Rule service, sharing one set of signal
 * claims as they do in the controller, so a rule created while an action
 * runs sees the action's claim.
 */
const buildSignalServices = (operations: Layer.Layer<BoundOperations, never, IgnoreRuleService>) =>
  SignalServiceLayer.pipe(
    Layer.provide(operations),
    Layer.provideMerge(IgnoreRuleServiceLayer),
    Layer.provide(SignalClaimsLayer),
    Layer.provide(PluginHostStub),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );

const layer = buildSignalServices(IgnoreRuleCreatingOperationsLayer);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const SIGNAL_GRANTS: ReadonlyArray<Grant> = ["signal.read", "signal.write"];

/**
 * Builds the actor of a session, in no run, whose profile holds `grants`.
 * `assistantId` names the assistant whose conversation the session answers.
 */
const buildSessionActor = (
  sessionId: string,
  grants = SIGNAL_GRANTS,
  assistantId: string | null = null,
): Actor => ({
  _tag: "session",
  sessionId,
  profileId: "0199e0e7-0000-7000-8000-00000000d001",
  grants,
  profileGrants: grants,
  assistantId,
  agentId: null,
});

const TRIAGE_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b501";
const TRIAGE = buildSessionActor(TRIAGE_SESSION_ID);
const OTHER_SESSION = buildSessionActor("0199e0e7-0000-7000-8000-00000000b502");
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";
const WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000f001";
const AT = "2026-10-10T10:00:00.000Z";

const as =
  (actor: Actor) =>
  <A, E>(effect: Effect.Effect<A, E, Deps>): Effect.Effect<A, E, Deps> =>
    Effect.provideService(effect, CurrentActor, actor);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer));

/**
 * Builds a `BoundOperations` port whose operations wait until the test lets
 * them finish, so a test can act on a signal while an action on it runs:
 *
 * - `check` lets a plugin action through, and checks a contract operation as
 *   the fake port does;
 * - `run` and `runPluginAction` wait for `release`; `started` succeeds once
 *   the first of them is waiting;
 * - `pluginRuns` counts the calls of `runPluginAction`.
 */
const buildHeldOperations = () => {
  let markStarted!: () => void;
  let markReleased!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const released = new Promise<void>((resolve) => (markReleased = resolve));
  const counts = { pluginRuns: 0 };
  const hold = Effect.promise(() => {
    markStarted();
    return released;
  });
  const port = BoundOperations.of({
    check: (place, operation, _field, path) =>
      isQualifiedId(operation.op)
        ? Effect.succeed(operation)
        : decodeAnswerOperation(place, operation, [...path, "operation"]),
    run: () => hold,
    runPluginAction: () =>
      Effect.andThen(
        Effect.sync(() => counts.pluginRuns++),
        Effect.as(hold, undefined),
      ),
    describe: (operations) =>
      Effect.succeed(operations.map((operation) => [{ kind: "text", text: operation.op }])),
  });
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
      Effect.runPromise(
        Effect.provide(effect, buildSignalServices(Layer.succeed(BoundOperations, port))),
      ),
    started: Effect.promise(() => started),
    release: Effect.sync(() => markReleased()),
    counts,
  };
};

/** A plugin action an offer carries, which the held port lets through. */
const PLUGIN_ACTION: BoundAction = {
  id: "approve",
  label: "Approve",
  operation: { op: "forge/review", input: {} },
};

/** Runs `effect` and returns the error it fails with. Fails the test if it succeeds. */
const fail = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<E> => run(Effect.flip(effect));

const PROPOSAL: SignalRaiseInput = {
  kind: "proposal",
  title: "Fix the flaky login test",
  reason: "Three failures this week on main.",
  eventIds: [],
  task: { title: "Fix the flaky login test", description: "It fails one run in ten." },
};

const OFFER: SignalRaiseInput = {
  kind: "offer",
  title: "Merge the dev bumps",
  reason: "Four green dependency pull requests.",
  eventIds: [],
};

const service = Effect.service(SignalService);

/** Raises `input` as `actor` and returns the stored signal. */
const raiseAndRead = (input: SignalRaiseInput, actor: Actor = TRIAGE) =>
  Effect.gen(function* () {
    const signals = yield* service;
    const { signalId } = yield* as(actor)(signals.raise(input));
    return yield* as(USER)(signals.read(signalId));
  });

const listActionIds = (signal: Signal) => signal.actions.map((action) => action.id);

/** Stores an enabled workflow with this definition. */
const insertEnabledWorkflow = (definition: WorkflowDefinition) =>
  Effect.gen(function* () {
    const workflows = yield* workflowRepository;
    const stored = yield* workflows.insert({ source: "steps: []\n", definition }, AT);
    yield* workflows.update(stored.id, { enabled: true }, AT);
    return stored.id;
  });

/**
 * Builds a workflow whose `signal` input accepts `kinds`. Its other required
 * input has a default, unless `topicDefault` is null.
 */
const buildSignalInputWorkflow = (
  name: string,
  kinds: ReadonlyArray<string>,
  topicDefault: string | null = "inbox",
) =>
  ({
    name,
    inputs: [
      {
        name: "topic",
        schema: { type: "string" },
        required: true,
        ...(topicDefault === null ? {} : { default: topicDefault }),
      },
      { name: "signal", signal: { kinds: [...kinds] }, required: true },
    ],
    steps: [],
  }) as unknown as WorkflowDefinition;

describe("signal.raise", () => {
  it("lays out Accept and Dismiss on a proposal, stamps the raiser, and records one entry", async () => {
    const { signal, entries } = await run(
      Effect.gen(function* () {
        const signal = yield* raiseAndRead(PROPOSAL);
        return { signal, entries: yield* readEventsOfKind("signal.raised") };
      }),
    );

    expect(signal).toMatchObject({
      kind: "proposal",
      status: "open",
      priority: "normal",
      task: PROPOSAL.task,
      origin: { type: "api", actor: `session:${TRIAGE_SESSION_ID}` },
    });
    expect(
      signal.actions.map(({ id, label, operation, primary }) => ({
        id,
        label,
        operation,
        primary,
      })),
    ).toEqual([
      {
        id: "accept",
        label: "Accept",
        operation: { op: "task.create", input: PROPOSAL.task },
        primary: true,
      },
      { id: "dismiss", label: "Dismiss", operation: null, primary: undefined },
    ]);
    expect(entries.map((entry) => entry.payload)).toEqual([
      { signalId: signal.id, kind: "proposal" },
    ]);
  });

  it("stamps the assistant whose session raised the signal, and none for any other session", async () => {
    const assistantId = "0199e0e7-0000-7000-8000-00000000a001";
    const { byAssistant, bySession } = await run(
      Effect.gen(function* () {
        return {
          byAssistant: yield* raiseAndRead(
            PROPOSAL,
            buildSessionActor("0199e0e7-0000-7000-8000-00000000b503", SIGNAL_GRANTS, assistantId),
          ),
          bySession: yield* raiseAndRead(PROPOSAL),
        };
      }),
    );
    expect(byAssistant.origin).toMatchObject({ type: "api", assistantId });
    expect(bySession.origin).not.toHaveProperty("assistantId");
  });

  it("puts the raiser's actions first, then Hand to an agent, then the core's own", async () => {
    const own: BoundAction = {
      id: "start",
      label: "Start now",
      operation: { op: "run.start", input: { workflowId: WORKFLOW_ID } },
    };
    const { signal, workflowId } = await run(
      Effect.gen(function* () {
        const workflowId = yield* insertEnabledWorkflow(
          buildSignalInputWorkflow("Merge bot", ["offer"]),
        );
        // Accepts another kind, so it is not offered.
        yield* insertEnabledWorkflow(buildSignalInputWorkflow("Mail bot", ["gmail/mail"]));
        // Needs a topic the action cannot fill, so run.start would refuse the click.
        yield* insertEnabledWorkflow(buildSignalInputWorkflow("Topic bot", ["offer"], null));
        // Accepts the kind but no longer validates, so run.start would refuse the click.
        const invalidId = yield* insertEnabledWorkflow(
          buildSignalInputWorkflow("Invalid bot", ["offer"]),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE workflows SET invalid_since = ${AT} WHERE id = ${uuidFromString(invalidId)}`;
        return { signal: yield* raiseAndRead({ ...OFFER, actions: [own] }), workflowId };
      }),
    );

    expect(listActionIds(signal)).toEqual(["start", `hand-to-${workflowId}`, "dismiss"]);
    expect(signal.actions[1]).toMatchObject({
      label: "Hand to Merge bot",
      operation: {
        op: "run.start",
        input: { workflowId, inputs: { signal: signal.id } },
      },
    });
  });

  it("offers no Hand to an agent on a proposal, Done on an fyi, and nothing of its own on an unsure", async () => {
    const signals = await run(
      Effect.all({
        fyi: raiseAndRead({ ...OFFER, kind: "fyi" }),
        unsure: raiseAndRead({ ...OFFER, kind: "unsure" }),
      }),
    );

    expect(listActionIds(signals.fyi)).toEqual(["done"]);
    expect(listActionIds(signals.unsure)).toEqual([]);
  });

  it("refuses an action that repeats a core action's id or label, and a typed reply on an action that runs nothing", async () => {
    const error = await fail(
      as(TRIAGE)(
        Effect.flatMap(service, (signals) =>
          signals.raise({
            ...OFFER,
            actions: [
              { id: "skip", label: "Dismiss", operation: null },
              {
                id: "note",
                label: "Note",
                operation: null,
                field: { name: "body", placeholder: "Write a note" },
              },
            ],
          }),
        ),
      ),
    );

    expect(error).toMatchObject({ error: { code: "validation" } });
    expect(
      (
        error as { error: { details: { issues: ReadonlyArray<{ path: unknown }> } } }
      ).error.details.issues.map((issue) => issue.path),
    ).toEqual([
      ["actions", "0"],
      ["actions", "1", "field"],
    ]);
  });

  it("refuses an action whose operation may not run as a signal's answer, at its path", async () => {
    const error = await fail(
      as(TRIAGE)(
        Effect.flatMap(service, (signals) =>
          signals.raise({
            ...OFFER,
            actions: [
              { id: "wipe", label: "Delete it", operation: { op: "task.delete", input: {} } },
            ],
          }),
        ),
      ),
    );

    const issues = (error as { error: { details: { issues: ReadonlyArray<{ path: unknown }> } } })
      .error.details.issues;
    expect(issues[0]?.path).toEqual(["actions", "0", "operation", "op"]);
  });

  it("refuses an action that runs ignoreRule.create, because only the core's offer binds it", async () => {
    const { error, stored } = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const error = yield* Effect.flip(
          as(TRIAGE)(
            signals.raise({
              ...OFFER,
              actions: [
                {
                  id: "hide",
                  label: "Hide these",
                  operation: {
                    op: "ignoreRule.create",
                    input: { kind: PLUGIN_KIND, match: BOT_MATCH },
                  },
                },
              ],
            }),
          ),
        );
        return { error, stored: yield* as(USER)(signals.query({})) };
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: { issues: [{ path: ["actions", "0", "operation", "op"] }] },
      },
    });
    expect(
      (error as { error: { details: { issues: ReadonlyArray<{ message: string }> } } }).error
        .details.issues[0]!.message,
    ).toContain("only the core binds it");
    expect(stored.items).toEqual([]);
  });

  it("refuses a proposal whose task Accept could not bind, as the signal it would store", async () => {
    const error = await fail(
      as(TRIAGE)(
        Effect.flatMap(service, (signals) =>
          signals.raise({
            ...PROPOSAL,
            task: { title: "Too long", description: "x".repeat(MAX_BOUND_INPUT_BYTES) },
          }),
        ),
      ),
    );

    expect(error).toMatchObject({ error: { code: "validation" } });
    const issues = (error as { error: { details: { issues: ReadonlyArray<{ path: unknown }> } } })
      .error.details.issues;
    expect(issues[0]?.path).toEqual(["actions", "0", "operation", "input"]);
  });

  it("lays out Hand to for a workflow whose name is as long as a workflow name may be", async () => {
    const name = "w".repeat(128);
    const signal = await run(
      Effect.gen(function* () {
        yield* insertEnabledWorkflow(buildSignalInputWorkflow(name, ["offer"]));
        return yield* raiseAndRead(OFFER);
      }),
    );

    expect(signal.actions[0]?.label).toBe(`Hand to ${name}`);
  });

  it("refuses a caller without signal.write", async () => {
    const error = await fail(
      as(buildSessionActor(UNKNOWN_ID, ["signal.read"]))(
        Effect.flatMap(service, (signals) => signals.raise(OFFER)),
      ),
    );

    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("signal.query and signal.read", () => {
  it("lists the open signals oldest first, filtered by kind, and adds describe lines only for the user", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const offer = yield* as(TRIAGE)(signals.raise(OFFER));
        const fyi = yield* as(TRIAGE)(signals.raise({ ...OFFER, kind: "fyi" }));
        return {
          ids: [offer.signalId, fyi.signalId],
          all: (yield* as(USER)(signals.query({}))).items,
          offers: (yield* as(USER)(signals.query({ kind: "offer" }))).items,
          bySource: (yield* as(USER)(signals.query({ source: "github" }))).items,
          forSession: yield* as(TRIAGE)(signals.read(fyi.signalId)),
        };
      }),
    );

    expect(result.all.map((signal) => signal.id)).toEqual(result.ids);
    expect(result.offers.map((signal) => signal.id)).toEqual([result.ids[0]]);
    // A core kind belongs to no plugin.
    expect(result.bySource).toEqual([]);
    expect(result.all[0]!.actions[0]!.describeLine).toEqual([
      { kind: "text", text: "Does nothing" },
    ]);
    expect(result.all[1]!.actions[0]!.describeLine).toEqual([
      { kind: "text", text: "Takes it off your list" },
    ]);
    expect(result.forSession.actions[0]!.describeLine).toBeUndefined();
  });

  it("says on a plugin's signal that Done does not tell the plugin", async () => {
    const signal: Signal = {
      id: "0199e0e7-0000-7000-8000-00000000c001",
      kind: PLUGIN_KIND,
      origin: {
        type: "event",
        eventId: 1,
        connectionId: "0199e0e7-0000-7000-8000-00000000c002",
        threadRef: "acme/web#1",
      },
      title: "Review acme/web#1",
      priority: "normal",
      blocks: [],
      actions: [{ id: DONE_ACTION_ID, label: "Done", operation: null }],
      match: {},
      status: "open",
      createdAt: AT,
    };
    const read = await run(
      Effect.gen(function* () {
        const repository = yield* signalRepository;
        yield* repository.insert(signal, [1]);
        return yield* as(USER)(Effect.flatMap(service, (signals) => signals.read(signal.id)));
      }),
    );

    expect(read.actions[0]!.describeLine).toEqual([
      { kind: "text", text: "Takes it off your list. Acme is not told" },
    ]);
  });

  it("fails with NotFound for an id no signal has", async () => {
    const error = await fail(
      as(USER)(Effect.flatMap(service, (signals) => signals.read(UNKNOWN_ID))),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("signal.act", () => {
  it("resolves the signal with the action the user took, and records one entry", async () => {
    const { acted, entries } = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(signals.raise(OFFER));
        const acted = yield* as(USER)(signals.act({ id: signalId, actionId: "dismiss" }));
        return { acted, entries: yield* readEventsOfKind("signal.decided") };
      }),
    );

    expect(acted.status).toBe("resolved");
    expect(acted.resolution).toMatchObject({
      kind: "decided",
      actionId: "dismiss",
      outcome: "Dismissed",
      actor: "user",
    });
    expect(entries.map((entry) => [entry.actor, entry.payload])).toEqual([
      ["user", { signalId: acted.id, actionId: "dismiss", op: null }],
    ]);
  });

  it("refuses a second action on a resolved signal", async () => {
    const error = await fail(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(signals.raise(OFFER));
        yield* as(USER)(signals.act({ id: signalId, actionId: "dismiss" }));
        return yield* as(USER)(signals.act({ id: signalId, actionId: "dismiss" }));
      }),
    );

    expect(error).toMatchObject({ error: { code: "invalid_state" } });
  });

  it("refuses a session, an action the signal does not have, and text for an action that takes none", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(signals.raise(OFFER));
        return {
          session: yield* Effect.flip(
            as(TRIAGE)(signals.act({ id: signalId, actionId: "dismiss" })),
          ),
          missing: yield* Effect.flip(as(USER)(signals.act({ id: signalId, actionId: "merge" }))),
          text: yield* Effect.flip(
            as(USER)(signals.act({ id: signalId, actionId: "dismiss", text: "No thanks" })),
          ),
          still: yield* as(USER)(signals.read(signalId)),
        };
      }),
    );

    expect(errors.session).toMatchObject({ error: { code: "forbidden" } });
    expect(errors.missing).toMatchObject({ error: { code: "not_found" } });
    expect(errors.text).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["text"] }] } },
    });
    expect(errors.still.status).toBe("open");
  });

  it("refuses a plugin action while a core action on the same signal runs", async () => {
    const held = buildHeldOperations();
    const { refused, acted } = await held.run(
      Effect.gen(function* () {
        const signals = yield* service;
        const own: BoundAction = {
          id: "file",
          label: "File it",
          operation: { op: "task.create", input: { title: "File it", description: "" } },
        };
        const { signalId } = yield* as(TRIAGE)(
          signals.raise({ ...OFFER, actions: [own, PLUGIN_ACTION] }),
        );
        const first = yield* Effect.forkChild(
          as(USER)(signals.act({ id: signalId, actionId: "file" })),
        );
        yield* held.started;
        const refused = yield* Effect.flip(
          as(USER)(signals.act({ id: signalId, actionId: "approve" })),
        );
        yield* held.release;
        return { refused, acted: yield* Fiber.join(first) };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "invalid_state" } });
    expect(held.counts.pluginRuns).toBe(0);
    expect(acted.resolution).toMatchObject({ kind: "decided", actionId: "file" });
  });

  it("runs the same plugin action once when it is taken twice at once", async () => {
    const held = buildHeldOperations();
    const { refused, acted } = await held.run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(
          signals.raise({ ...OFFER, actions: [PLUGIN_ACTION] }),
        );
        const take = as(USER)(signals.act({ id: signalId, actionId: "approve" }));
        const first = yield* Effect.forkChild(take);
        yield* held.started;
        const refused = yield* Effect.flip(take);
        yield* held.release;
        return { refused, acted: yield* Fiber.join(first) };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "invalid_state" } });
    expect(held.counts.pluginRuns).toBe(1);
    expect(acted.resolution).toMatchObject({ kind: "decided", actionId: "approve" });
  });
});

describe("signal.withdraw", () => {
  it("lets the raiser withdraw its signal, and records one entry", async () => {
    const { withdrawn, entries } = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(signals.raise(OFFER));
        const withdrawn = yield* as(TRIAGE)(
          signals.withdraw({ id: signalId, reason: "The pull requests were merged." }),
        );
        return { withdrawn, entries: yield* readEventsOfKind("signal.withdrawn") };
      }),
    );

    expect(withdrawn.status).toBe("resolved");
    expect(withdrawn.resolution).toMatchObject({
      kind: "withdrawn",
      outcome: "The pull requests were merged.",
    });
    expect(entries.map((entry) => entry.payload)).toEqual([
      { signalId: withdrawn.id, reason: "The pull requests were merged." },
    ]);
  });

  it("refuses another session, the user, and a second withdrawal", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(signals.raise(OFFER));
        const input = { id: signalId, reason: "Not needed." };
        const other = yield* Effect.flip(as(OTHER_SESSION)(signals.withdraw(input)));
        const user = yield* Effect.flip(as(USER)(signals.withdraw(input)));
        yield* as(TRIAGE)(signals.withdraw(input));
        const twice = yield* Effect.flip(as(TRIAGE)(signals.withdraw(input)));
        return { other, user, twice };
      }),
    );

    expect(errors.other).toMatchObject({ error: { code: "forbidden" } });
    expect(errors.user).toMatchObject({ error: { code: "forbidden" } });
    expect(errors.twice).toMatchObject({ error: { code: "invalid_state" } });
  });

  it("refuses a withdrawal while an action on the signal runs, and the action still resolves it", async () => {
    const held = buildHeldOperations();
    const { refused, acted } = await held.run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(
          signals.raise({ ...OFFER, actions: [PLUGIN_ACTION] }),
        );
        const first = yield* Effect.forkChild(
          as(USER)(signals.act({ id: signalId, actionId: "approve" })),
        );
        yield* held.started;
        const refused = yield* Effect.flip(
          as(TRIAGE)(signals.withdraw({ id: signalId, reason: "Not needed." })),
        );
        yield* held.release;
        return { refused, acted: yield* Fiber.join(first) };
      }),
    );

    expect(refused).toMatchObject({
      error: {
        code: "invalid_state",
        message: "an action on this signal is running; withdraw it once it finishes",
      },
    });
    expect(acted.resolution).toMatchObject({ kind: "decided", actionId: "approve" });
  });
});

/**
 * Runs `effect` as `run` does, on a `TestClock` that starts at the epoch, so
 * a test can snooze a signal until a known time and then move past it.
 */
const runOnTestClock = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  run(effect.pipe(Effect.provide(TestClock.layer())));

const HOUR = 60 * 60 * 1000;
const IN_ONE_HOUR = "1970-01-01T01:00:00.000Z";
const IN_TWO_HOURS = "1970-01-01T02:00:00.000Z";
const IN_THREE_HOURS = "1970-01-01T03:00:00.000Z";
const FYI: SignalRaiseInput = { ...OFFER, kind: "fyi", title: "Release 4.2 shipped" };

/** Raises `input` as the triage session and returns the new signal's id. */
const raiseId = (input: SignalRaiseInput) =>
  Effect.flatMap(service, (signals) =>
    Effect.map(as(TRIAGE)(signals.raise(input)), (raised) => raised.signalId),
  );

/** Returns the ids of one view of the signals, as the user reads it. */
const listIds = (view: "to-do" | "later" | "done") =>
  Effect.flatMap(service, (signals) =>
    Effect.map(as(USER)(signals.query({ view })), (page) => page.items.map((item) => item.id)),
  );

describe("signal.markDone", () => {
  it("resolves each signal as Done once, skips a resolved one, removes its snooze, and records one entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const first = yield* raiseId(FYI);
        const second = yield* raiseId(FYI);
        const resolved = yield* raiseId(FYI);
        yield* as(TRIAGE)(signals.withdraw({ id: resolved, reason: "Not needed." }));
        yield* as(USER)(signals.snooze({ signalIds: [second], until: "2999-01-01T00:00:00.000Z" }));
        const marked = yield* as(USER)(
          signals.markDone({ signalIds: [first, second, first, resolved] }),
        );
        return {
          ids: { first, second, resolved },
          marked,
          read: yield* as(USER)(signals.read(second)),
          later: yield* listIds("later"),
          done: yield* listIds("done"),
          entries: yield* readEventsOfKind("signal.markedDone"),
        };
      }),
    );

    const { first, second, resolved } = result.ids;
    expect(result.marked).toEqual({
      done: [first, second],
      skipped: [{ signalId: resolved, reason: "resolved" }],
    });
    expect(result.read).not.toHaveProperty("snooze");
    expect(result.read.resolution).toMatchObject({
      kind: "decided",
      actionId: "done",
      outcome: "Done, nothing sent",
      actor: "user",
    });
    expect(result.later).toEqual([]);
    expect(result.done).toEqual(expect.arrayContaining([first, second, resolved]));
    expect(result.entries.map((entry) => entry.payload)).toEqual([{ signalIds: [first, second] }]);
  });

  it("changes nothing and records nothing when every signal is already resolved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const id = yield* raiseId(FYI);
        yield* as(USER)(signals.markDone({ signalIds: [id] }));
        return {
          again: yield* as(USER)(signals.markDone({ signalIds: [id] })),
          entries: yield* readEventsOfKind("signal.markedDone"),
        };
      }),
    );

    expect(result.again.done).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it("fails the whole call for an unknown id or a kind with no Done, and changes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const fyi = yield* raiseId(FYI);
        const offer = yield* raiseId(OFFER);
        return {
          unknown: yield* Effect.flip(as(USER)(signals.markDone({ signalIds: [fyi, UNKNOWN_ID] }))),
          noDone: yield* Effect.flip(as(USER)(signals.markDone({ signalIds: [fyi, offer] }))),
          toDo: yield* listIds("to-do"),
          ids: [fyi, offer],
        };
      }),
    );

    expect(result.unknown).toMatchObject({ error: { code: "not_found" } });
    expect(result.noDone).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["signalIds", "1"] }] } },
    });
    expect(result.toDo).toEqual(result.ids);
  });

  it("refuses a session, even one that holds signal.write", async () => {
    const error = await fail(
      Effect.gen(function* () {
        const signals = yield* service;
        const id = yield* raiseId(FYI);
        return yield* as(TRIAGE)(signals.markDone({ signalIds: [id] }));
      }),
    );

    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });

  it("refuses Done while an action on one of the signals runs", async () => {
    const held = buildHeldOperations();
    const { refused, acted } = await held.run(
      Effect.gen(function* () {
        const signals = yield* service;
        const { signalId } = yield* as(TRIAGE)(signals.raise({ ...FYI, actions: [PLUGIN_ACTION] }));
        const first = yield* Effect.forkChild(
          as(USER)(signals.act({ id: signalId, actionId: "approve" })),
        );
        yield* held.started;
        const refused = yield* Effect.flip(as(USER)(signals.markDone({ signalIds: [signalId] })));
        yield* held.release;
        return { refused, acted: yield* Fiber.join(first) };
      }),
    );

    expect(refused).toMatchObject({ error: { code: "invalid_state" } });
    expect(acted.resolution).toMatchObject({ kind: "decided", actionId: "approve" });
  });

  it("pages Done one signal at a time across signals resolved at the same time", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const ids = [yield* raiseId(FYI), yield* raiseId(FYI), yield* raiseId(FYI)];
        // One call resolves all three, so their resolutions share one time and
        // only the id orders them.
        yield* as(USER)(signals.markDone({ signalIds: ids }));
        const pages = [yield* as(USER)(signals.query({ view: "done", limit: 1 }))];
        while (pages.at(-1)!.nextCursor !== undefined && pages.length < 5) {
          pages.push(
            yield* as(USER)(
              signals.query({ view: "done", limit: 1, cursor: pages.at(-1)!.nextCursor! }),
            ),
          );
        }
        return { ids, pages };
      }),
    );

    expect(result.pages.map((page) => page.items.map((item) => item.id))).toEqual(
      [...result.ids]
        .sort()
        .reverse()
        .map((id) => [id]),
    );
    expect(result.pages.at(-1)).not.toHaveProperty("nextCursor");
  });

  it("announces the log once and each signal it changed", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const { ids, raisesAnnounced } = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const ids = [yield* raiseId(FYI), yield* raiseId(FYI)];
        const raisesAnnounced = announced.length;
        yield* as(USER)(signals.markDone({ signalIds: ids }));
        return { ids, raisesAnnounced };
      }).pipe(Effect.provide(listener)),
    );

    expect(announced.slice(raisesAnnounced)).toEqual([
      { _tag: "event" },
      ...ids.map((id) => ({ _tag: "record", topic: "signal", id, kind: "updated" })),
    ]);
  });
});

describe("signal.snooze and signal.unsnooze", () => {
  it("moves a signal to Later, replaces its time on a second snooze, and brings it back first when the time passes", async () => {
    const result = await runOnTestClock(
      Effect.gen(function* () {
        const signals = yield* service;
        const older = yield* raiseId(FYI);
        const snoozed = yield* raiseId(FYI);
        const first = yield* as(TRIAGE)(
          signals.snooze({ signalIds: [snoozed], until: IN_ONE_HOUR }),
        );
        yield* as(USER)(signals.snooze({ signalIds: [snoozed], until: IN_TWO_HOURS }));
        const whileSnoozed = {
          toDo: yield* listIds("to-do"),
          later: (yield* as(USER)(signals.query({ view: "later" }))).items,
        };
        yield* TestClock.adjust(2 * HOUR);
        return {
          ids: { older, snoozed },
          first,
          whileSnoozed,
          afterwards: { toDo: yield* listIds("to-do"), later: yield* listIds("later") },
          entries: yield* readEventsOfKind("signal.snoozed"),
        };
      }),
    );

    const { older, snoozed } = result.ids;
    expect(result.first).toEqual({ snoozed: [snoozed], skipped: [] });
    expect(result.whileSnoozed.toDo).toEqual([older]);
    expect(result.whileSnoozed.later.map((signal) => [signal.id, signal.snooze?.until])).toEqual([
      [snoozed, IN_TWO_HOURS],
    ]);
    expect(result.afterwards).toEqual({ toDo: [snoozed, older], later: [] });
    expect(result.entries.map((entry) => [entry.actor, entry.payload])).toEqual([
      [`session:${TRIAGE_SESSION_ID}`, { signalIds: [snoozed], until: IN_ONE_HOUR }],
      ["user", { signalIds: [snoozed], until: IN_TWO_HOURS }],
    ]);
  });

  it("refuses a time that is not in the future, and snoozes nothing", async () => {
    const result = await runOnTestClock(
      Effect.gen(function* () {
        const signals = yield* service;
        const id = yield* raiseId(FYI);
        yield* TestClock.adjust(HOUR);
        return {
          error: yield* Effect.flip(
            as(USER)(signals.snooze({ signalIds: [id], until: IN_ONE_HOUR })),
          ),
          later: yield* listIds("later"),
        };
      }),
    );

    expect(result.error).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["until"] }] } },
    });
    expect(result.later).toEqual([]);
  });

  it("puts a snoozed signal back on To do, and writes nothing for a signal that is not snoozed", async () => {
    const result = await runOnTestClock(
      Effect.gen(function* () {
        const signals = yield* service;
        const snoozed = yield* raiseId(FYI);
        const plain = yield* raiseId(FYI);
        yield* as(USER)(signals.snooze({ signalIds: [snoozed], until: IN_ONE_HOUR }));
        const unsnoozed = yield* as(USER)(signals.unsnooze({ signalIds: [snoozed, plain] }));
        const again = yield* as(USER)(signals.unsnooze({ signalIds: [snoozed] }));
        return {
          ids: { snoozed, plain },
          unsnoozed,
          again,
          toDo: yield* listIds("to-do"),
          entries: yield* readEventsOfKind("signal.unsnoozed"),
        };
      }),
    );

    expect(result.unsnoozed).toEqual({ unsnoozed: [result.ids.snoozed], skipped: [] });
    expect(result.again).toEqual({ unsnoozed: [], skipped: [] });
    expect(result.toDo).toEqual([result.ids.snoozed, result.ids.plain]);
    expect(result.entries.map((entry) => entry.payload)).toEqual([
      { signalIds: [result.ids.snoozed] },
    ]);
  });

  it("removes the snooze of a withdrawn signal, and skips it on a later snooze", async () => {
    const result = await runOnTestClock(
      Effect.gen(function* () {
        const signals = yield* service;
        const id = yield* raiseId(FYI);
        yield* as(USER)(signals.snooze({ signalIds: [id], until: IN_ONE_HOUR }));
        const withdrawn = yield* as(TRIAGE)(signals.withdraw({ id, reason: "Not needed." }));
        return {
          id,
          withdrawn,
          later: yield* listIds("later"),
          snoozedAgain: yield* as(USER)(signals.snooze({ signalIds: [id], until: IN_ONE_HOUR })),
        };
      }),
    );

    expect(result.withdrawn).not.toHaveProperty("snooze");
    expect(result.later).toEqual([]);
    expect(result.snoozedAgain).toEqual({
      snoozed: [],
      skipped: [{ signalId: result.id, reason: "resolved" }],
    });
  });

  it("pages Later soonest first and Done newest first, and refuses one view's cursor in the other", async () => {
    const result = await runOnTestClock(
      Effect.gen(function* () {
        const signals = yield* service;
        const ids = [yield* raiseId(FYI), yield* raiseId(FYI), yield* raiseId(FYI)];
        yield* as(USER)(signals.snooze({ signalIds: [ids[2]!], until: IN_ONE_HOUR }));
        yield* as(USER)(signals.snooze({ signalIds: [ids[0]!], until: IN_TWO_HOURS }));
        yield* as(USER)(signals.snooze({ signalIds: [ids[1]!], until: IN_THREE_HOURS }));
        const later1 = yield* as(USER)(signals.query({ view: "later", limit: 2 }));
        const later2 = yield* as(USER)(
          signals.query({ view: "later", limit: 2, cursor: later1.nextCursor! }),
        );
        for (const id of ids) {
          yield* TestClock.adjust(1000);
          yield* as(USER)(signals.markDone({ signalIds: [id] }));
        }
        const done1 = yield* as(USER)(signals.query({ view: "done", limit: 2 }));
        const done2 = yield* as(USER)(
          signals.query({ view: "done", limit: 2, cursor: done1.nextCursor! }),
        );
        const mixed = yield* Effect.flip(
          as(USER)(signals.query({ view: "done", limit: 2, cursor: later1.nextCursor! })),
        );
        return { ids, later1, later2, done1, done2, mixed };
      }),
    );

    const [a, b, c] = result.ids;
    const readIds = (page: { readonly items: ReadonlyArray<Signal> }) =>
      page.items.map((item) => item.id);
    expect(readIds(result.later1)).toEqual([c, a]);
    expect(readIds(result.later2)).toEqual([b]);
    expect(result.later2).not.toHaveProperty("nextCursor");
    expect(readIds(result.done1)).toEqual([c, b]);
    expect(readIds(result.done2)).toEqual([a]);
    expect(result.mixed).toMatchObject({ error: { code: "validation" } });
  });

  it("announces the log once and each signal it changed, for a snooze and an unsnooze", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const { ids, snoozeAnnounced, unsnoozeAnnounced } = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const ids = [yield* raiseId(FYI), yield* raiseId(FYI)];
        const before = announced.length;
        yield* as(USER)(signals.snooze({ signalIds: ids, until: "2999-01-01T00:00:00.000Z" }));
        const snoozeAnnounced = announced.slice(before);
        const between = announced.length;
        yield* as(USER)(signals.unsnooze({ signalIds: ids }));
        return { ids, snoozeAnnounced, unsnoozeAnnounced: announced.slice(between) };
      }).pipe(Effect.provide(listener)),
    );

    const expected = [
      { _tag: "event" },
      ...ids.map((id) => ({ _tag: "record", topic: "signal", id, kind: "updated" })),
    ];
    expect(snoozeAnnounced).toEqual(expected);
    expect(unsnoozeAnnounced).toEqual(expected);
  });
});

describe("signal.lowerPriority", () => {
  it("moves an urgent signal to high, marks it lowered, leaves the rest, and records one entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const sql = yield* SqlClient.SqlClient;
        const urgent = yield* raiseId(FYI);
        const normal = yield* raiseId(OFFER);
        const resolved = yield* raiseId(OFFER);
        yield* as(TRIAGE)(signals.withdraw({ id: resolved, reason: "Not needed." }));
        // Only a plugin's kind may be urgent, so the test sets the priority directly.
        yield* sql`UPDATE signals SET priority = 'urgent' WHERE kind = 'fyi'`;
        const lowered = yield* as(USER)(
          signals.lowerPriority({ signalIds: [urgent, normal, resolved] }),
        );
        const repository = yield* signalRepository;
        return {
          ids: { urgent, normal, resolved },
          lowered,
          read: yield* as(USER)(signals.read(urgent)),
          isLowered: [
            yield* repository.isPriorityLowered(urgent),
            yield* repository.isPriorityLowered(normal),
          ],
          entries: yield* readEventsOfKind("signal.priorityLowered"),
        };
      }),
    );

    expect(result.lowered).toEqual({
      lowered: [result.ids.urgent],
      skipped: [{ signalId: result.ids.resolved, reason: "resolved" }],
    });
    expect(result.read.priority).toBe("high");
    expect(result.isLowered).toEqual([true, false]);
    expect(result.entries.map((entry) => entry.payload)).toEqual([
      { signalIds: [result.ids.urgent] },
    ]);
  });

  it("refuses a session, even one that holds signal.write", async () => {
    const error = await fail(
      Effect.gen(function* () {
        const signals = yield* service;
        const id = yield* raiseId(FYI);
        return yield* as(TRIAGE)(signals.lowerPriority({ signalIds: [id] }));
      }),
    );

    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });

  it("announces the log once and each signal it lowered", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const { ids, loweredAnnounced } = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const sql = yield* SqlClient.SqlClient;
        const ids = [yield* raiseId(FYI), yield* raiseId(FYI)];
        yield* sql`UPDATE signals SET priority = 'urgent'`;
        const before = announced.length;
        yield* as(USER)(signals.lowerPriority({ signalIds: ids }));
        return { ids, loweredAnnounced: announced.slice(before) };
      }).pipe(Effect.provide(listener)),
    );

    expect(loweredAnnounced).toEqual([
      { _tag: "event" },
      ...ids.map((id) => ({ _tag: "record", topic: "signal", id, kind: "updated" })),
    ]);
  });
});

/** The values of one group of the plugin's signals: one repository, one author. */
const BOT_MATCH: SignalMatch = { repo: "acme/web", author: "dependabot[bot]" };
const OTHER_MATCH: SignalMatch = { repo: "acme/web", author: "renovate[bot]" };

/**
 * Writes `count` open signals of the plugin's kind with the values `match`,
 * as an event would raise them, and returns their ids oldest first. Each is
 * created `firstSecond` seconds after `AT` or later, one second apart, because
 * the streak is counted from the newest signal back. Each carries `actions`,
 * the core's Done unless given.
 */
const insertAskedSignals = (
  match: SignalMatch,
  count: number,
  firstSecond = 0,
  actions: ReadonlyArray<BoundAction> = [{ id: DONE_ACTION_ID, label: "Done", operation: null }],
) =>
  Effect.gen(function* () {
    const repository = yield* signalRepository;
    const ids: Array<string> = [];
    for (let index = 0; index < count; index++) {
      const id = uuidToString(mintUuid());
      yield* repository.insert(
        {
          id,
          kind: PLUGIN_KIND,
          origin: {
            type: "event",
            eventId: 1,
            connectionId: "0199e0e7-0000-7000-8000-00000000c002",
            threadRef: `acme/web#${id}`,
          },
          title: "Review acme/web#1",
          priority: "normal",
          blocks: [],
          actions,
          match,
          status: "open",
          createdAt: new Date(Date.parse(AT) + (firstSecond + index) * 1000).toISOString(),
        },
        [],
      );
      ids.push(id);
    }
    return ids;
  });

/** Marks the signals done as the user. */
const markDone = (ids: ReadonlyArray<string>) =>
  Effect.flatMap(service, (signals) => as(USER)(signals.markDone({ signalIds: ids })));

/** Returns the core's Ignore Rule offers, open or resolved, oldest first. */
const listIgnoreRuleOffers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const signals = yield* service;
  const rows = yield* sql<{ readonly id: Uint8Array }>`
    SELECT id FROM signals WHERE ignore_rule IS NOT NULL ORDER BY created_at, id
  `;
  return yield* Effect.forEach(rows, (row) => as(USER)(signals.read(uuidToString(row.id))));
});

/** Resolves a signal directly, as an end on the source would. */
const resolveDirectly = (id: string, resolution: Partial<SignalResolution>) =>
  Effect.flatMap(signalRepository, (repository) =>
    repository.resolve(id, {
      kind: "decided",
      outcome: "Answered on the source",
      actor: "user",
      origin: "core",
      at: AT,
      ...resolution,
    }),
  );

describe("the core's Ignore Rule offer", () => {
  it("offers a rule once the user marked the last five of a group done without answering", async () => {
    const { offers, entries } = await run(
      Effect.gen(function* () {
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5));
        return {
          offers: yield* listIgnoreRuleOffers,
          entries: yield* readEventsOfKind("signal.raised"),
        };
      }),
    );

    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    expect(offer).toMatchObject({
      kind: "offer",
      status: "open",
      priority: "normal",
      title:
        "Ignore Question asked where Repository is acme/web and Author is dependabot[bot]? You marked the last 5 done without answering.",
      origin: {
        type: "api",
        actor: "system",
        eventIds: [],
        reason: "You marked the last 5 done without answering.",
      },
      ignoreRule: { kind: PLUGIN_KIND, match: BOT_MATCH },
      match: {},
    });
    expect(
      offer.actions.map(({ id, label, primary, operation }) => ({ id, label, primary, operation })),
    ).toEqual([
      {
        id: "ignore",
        label: "Ignore",
        primary: true,
        operation: { op: "ignoreRule.create", input: { kind: PLUGIN_KIND, match: BOT_MATCH } },
      },
      { id: "dismiss", label: "Dismiss", primary: undefined, operation: null },
    ]);
    expect(entries.map((entry) => [entry.actor, entry.payload])).toEqual([
      ["system", { signalId: offer.id, kind: "offer" }],
    ]);
  });

  it("offers nothing after four, or when the newest signal is still open", async () => {
    const offers = await run(
      Effect.gen(function* () {
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 4));
        const afterFour = (yield* listIgnoreRuleOffers).length;
        const ids = yield* insertAskedSignals(OTHER_MATCH, 6);
        yield* markDone(ids.slice(0, 5));
        return { afterFour, withNewerOpen: (yield* listIgnoreRuleOffers).length };
      }),
    );

    expect(offers).toEqual({ afterFour: 0, withNewerOpen: 0 });
  });

  it("skips a withdrawn signal, and counts an answer other than Done as the end of the streak", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const bot = yield* insertAskedSignals(BOT_MATCH, 6);
        yield* resolveDirectly(bot[2]!, { kind: "withdrawn", outcome: "Request removed" });
        yield* markDone(bot.filter((_, index) => index !== 2));
        const other = yield* insertAskedSignals(OTHER_MATCH, 6);
        yield* resolveDirectly(other[3]!, { actionId: "approve" });
        yield* markDone(other.filter((_, index) => index !== 3));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.ignoreRule)).toEqual([
      { kind: PLUGIN_KIND, match: BOT_MATCH },
    ]);
  });

  it("groups signals whose values were built in another order, as after a plugin update reorders its match fields", async () => {
    const reordered: SignalMatch = { author: "dependabot[bot]", repo: "acme/web" };
    const offers = await run(
      Effect.gen(function* () {
        // Three Dones in the old order and two in the new one make a streak of five.
        const old = yield* insertAskedSignals(BOT_MATCH, 3);
        yield* markDone([...old, ...(yield* insertAskedSignals(reordered, 2, 3))]);
        // A newer open signal in the new order ends the streak of the old order.
        const other = yield* insertAskedSignals(OTHER_MATCH, 5, 10);
        yield* insertAskedSignals({ author: "renovate[bot]", repo: "acme/web" }, 1, 20);
        yield* markDone(other);
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.ignoreRule)).toEqual([
      { kind: PLUGIN_KIND, match: BOT_MATCH },
    ]);
  });

  it("offers nothing for a group whose rule ignoreRule.create would refuse", async () => {
    const offers = await run(
      Effect.gen(function* () {
        // A field the kind no longer declares, as after a plugin update removed it.
        yield* markDone(yield* insertAskedSignals({ ...BOT_MATCH, team: "core" }, 5));
        // A value longer than a rule accepts, stored before that limit existed.
        const long = { ...OTHER_MATCH, author: "x".repeat(MAX_SIGNAL_MATCH_VALUE_LENGTH + 1) };
        yield* markDone(yield* insertAskedSignals(long, 5, 10));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers).toEqual([]);
  });

  it("counts every Done of the streak in the title, not only the last five", async () => {
    const offers = await run(
      Effect.gen(function* () {
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 7));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.title)).toEqual([
      "Ignore Question asked where Repository is acme/web and Author is dependabot[bot]? You marked the last 7 done without answering.",
    ]);
  });

  it("orders signals created at the same time by id, so an older id that is still open does not end the streak", async () => {
    const offers = await run(
      Effect.gen(function* () {
        // UUIDs as text sort in the order of their bytes, which is the order
        // the database compares them in.
        const sql = yield* SqlClient.SqlClient;
        const bot = [...(yield* insertAskedSignals(BOT_MATCH, 6, 0))].sort();
        const other = [...(yield* insertAskedSignals(OTHER_MATCH, 6, 10))].sort();
        yield* sql`UPDATE signals SET created_at = ${AT}`;
        yield* markDone(bot.slice(1));
        const afterOldestOpen = (yield* listIgnoreRuleOffers).length;
        yield* markDone(other.slice(0, 5));
        return { afterOldestOpen, offers: yield* listIgnoreRuleOffers };
      }),
    );

    expect(offers.afterOldestOpen).toBe(1);
    expect(offers.offers.map((offer) => offer.ignoreRule?.match)).toEqual([BOT_MATCH]);
  });

  it("counts a snoozed signal as open, so it ends the streak", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const bot = yield* insertAskedSignals(BOT_MATCH, 6);
        yield* as(USER)(
          signals.snooze({ signalIds: [bot[5]!], until: "2999-01-01T00:00:00.000Z" }),
        );
        yield* markDone(bot.slice(0, 5));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers).toEqual([]);
  });

  it("skips a signal a newer one replaced, even the newest of the group", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const bot = yield* insertAskedSignals(BOT_MATCH, 6);
        yield* resolveDirectly(bot[5]!, {
          kind: "withdrawn",
          outcome: "Replaced by a newer one",
          actor: "system",
        });
        yield* markDone(bot.slice(0, 5));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.ignoreRule)).toEqual([
      { kind: PLUGIN_KIND, match: BOT_MATCH },
    ]);
  });

  it("offers nothing again after the user took Ignore and later deleted the rule", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        const rules = yield* ignoreRuleRepository;
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5, 0));
        const [offer] = yield* listIgnoreRuleOffers;
        yield* as(USER)(signals.act({ id: offer!.id, actionId: "ignore" }));
        const [rule] = yield* rules.list(PLUGIN_KIND);
        yield* rules.delete(rule!.id);
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5, 10));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => [offer.status, offer.resolution?.actionId])).toEqual([
      ["resolved", "ignore"],
    ]);
  });

  it("never offers the same rule again, while its offer is open or after it was dismissed", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5, 0));
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5, 10));
        const [offer] = yield* listIgnoreRuleOffers;
        yield* as(USER)(signals.act({ id: offer!.id, actionId: "dismiss" }));
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5, 20));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.status)).toEqual(["resolved"]);
  });

  it("offers nothing when a rule with the same values exists", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        yield* rules.insert({
          id: uuidToString(mintUuid()),
          kind: PLUGIN_KIND,
          match: BOT_MATCH,
          text: "Question asked · Repository acme/web · Author dependabot[bot]",
          createdAt: AT,
          actor: "user",
        });
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers).toEqual([]);
  });

  it("offers one rule per group when one call marks two groups done, and none for a core kind", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const bot = yield* insertAskedSignals(BOT_MATCH, 5, 0);
        const other = yield* insertAskedSignals(OTHER_MATCH, 5, 10);
        const fyis = [];
        for (let index = 0; index < 5; index++) fyis.push(yield* raiseId(FYI));
        yield* markDone([...bot, ...other, ...fyis]);
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.ignoreRule?.match)).toEqual(
      expect.arrayContaining([BOT_MATCH, OTHER_MATCH]),
    );
    expect(offers).toHaveLength(2);
  });

  it("creates the rule when the user takes Ignore, and resolves the offer and the open signals it matches", async () => {
    const result = await run(
      Effect.gen(function* () {
        const signals = yield* service;
        yield* markDone(yield* insertAskedSignals(BOT_MATCH, 5, 0));
        const [matched] = yield* insertAskedSignals(BOT_MATCH, 1, 10);
        const [unmatched] = yield* insertAskedSignals(OTHER_MATCH, 1, 11);
        const [offer] = yield* listIgnoreRuleOffers;
        const acted = yield* as(USER)(signals.act({ id: offer!.id, actionId: "ignore" }));
        return {
          acted,
          matched: yield* as(USER)(signals.read(matched!)),
          unmatched: yield* as(USER)(signals.read(unmatched!)),
          rules: yield* Effect.flatMap(ignoreRuleRepository, (rules) => rules.list(PLUGIN_KIND)),
        };
      }),
    );

    const text = "Question asked · Repository acme/web · Author dependabot[bot]";
    expect(result.rules.map(({ match, text, actor }) => ({ match, text, actor }))).toEqual([
      { match: BOT_MATCH, text, actor: "user" },
    ]);
    expect(result.acted.resolution).toMatchObject({
      kind: "decided",
      actionId: "ignore",
      outcome: `Ignored · rule ${text}`,
      actor: "user",
    });
    expect(result.matched.resolution).toMatchObject({ kind: "decided", actionId: "ignore" });
    expect(result.unmatched.status).toBe("open");
  });

  it("counts an answer on the source that names no action as the end of the streak", async () => {
    const offers = await run(
      Effect.gen(function* () {
        const bot = yield* insertAskedSignals(BOT_MATCH, 6);
        // The resolution `resolveDirectly` writes names no action.
        yield* resolveDirectly(bot[3]!, {});
        yield* markDone(bot.filter((_, index) => index !== 3));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers).toEqual([]);
  });

  it("shows an empty match value as (empty) in the offer's title", async () => {
    const offers = await run(
      Effect.gen(function* () {
        yield* markDone(yield* insertAskedSignals({ repo: "acme/web", author: "" }, 5));
        return yield* listIgnoreRuleOffers;
      }),
    );

    expect(offers.map((offer) => offer.title)).toEqual([
      "Ignore Question asked where Repository is acme/web and Author is (empty)? You marked the last 5 done without answering.",
    ]);
  });

  it("leaves a signal open when the user creates a rule that matches it while an action on it runs, and the action resolves it", async () => {
    const held = buildHeldOperations();
    const { acted, entries } = await held.run(
      Effect.gen(function* () {
        const signals = yield* service;
        const rules = yield* Effect.service(IgnoreRuleService);
        const [id] = yield* insertAskedSignals(BOT_MATCH, 1, 0, [PLUGIN_ACTION]);
        const acting = yield* Effect.forkChild(
          as(USER)(signals.act({ id: id!, actionId: PLUGIN_ACTION.id })),
        );
        yield* held.started;
        yield* as(USER)(rules.create({ kind: PLUGIN_KIND, match: BOT_MATCH }));
        const whileActing = yield* as(USER)(signals.read(id!));
        yield* held.release;
        return {
          acted: { whileActing, after: yield* Fiber.join(acting) },
          entries: yield* readEventsOfKind("ignoreRule.created"),
        };
      }),
    );

    expect(acted.whileActing.status).toBe("open");
    expect(acted.after.resolution).toMatchObject({ kind: "decided", actionId: "approve" });
    expect(entries.map((entry) => entry.payload["signalIds"])).toEqual([[]]);
  });
});
