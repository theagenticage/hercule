/**
 * Tests the signal service against a migrated in-memory database, with the
 * fake `BoundOperations` port: who may raise, act on and withdraw a signal,
 * the actions the core lays out beside the raiser's, how the list filters,
 * and what each write records in the audit log.
 *
 * What an operation really does when the user takes an action, a plugin
 * action with a typed reply, and the real describe lines are tested over
 * HTTP in `signals.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  decodeAnswerOperation,
  isQualifiedId,
  MAX_BOUND_INPUT_BYTES,
  type BoundAction,
  type Grant,
  type Signal,
  type SignalRaiseInput,
  type WorkflowDefinition,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { BoundOperations } from "../bound-actions";
import { FakeBoundOperationsLayer } from "../bound-actions/testing";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { workflowRepository } from "../workflows";
import { SignalService, SignalServiceLayer } from "./index";

type Deps = SignalService | SqlClient.SqlClient;

const layer = SignalServiceLayer.pipe(
  Layer.provide(FakeBoundOperationsLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const SIGNAL_GRANTS: ReadonlyArray<Grant> = ["signal.read", "signal.write"];

/** Builds the actor of a session, in no run, whose profile holds `grants`. */
const buildSessionActor = (sessionId: string, grants = SIGNAL_GRANTS): Actor => ({
  _tag: "session",
  sessionId,
  profileId: "0199e0e7-0000-7000-8000-00000000d001",
  grants,
  profileGrants: grants,
  assistantId: null,
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
        Effect.provide(
          effect,
          SignalServiceLayer.pipe(
            Layer.provide(Layer.succeed(BoundOperations, port)),
            Layer.provideMerge(AuditLogLayer),
            Layer.provideMerge(TestDatabase),
          ),
        ),
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

const buildSignalInputWorkflow = (name: string, kinds: ReadonlyArray<string>) =>
  ({
    name,
    inputs: [
      { name: "topic", schema: { type: "string" }, required: true },
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
          all: yield* as(USER)(signals.query({})),
          offers: yield* as(USER)(signals.query({ kind: "offer" })),
          bySource: yield* as(USER)(signals.query({ source: "github" })),
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
