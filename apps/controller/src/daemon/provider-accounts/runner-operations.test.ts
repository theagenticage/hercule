/**
 * Tests the Provider Account operations that talk to a runner, on a real
 * database and the real plugin host. The cases here are the ones refused
 * before any frame is sent, so no runner needs to answer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ProbeResult } from "@hercule/protocol";
import { CurrentActor } from "../../actor";
import { AssistantService } from "../../assistants";
import { withTransaction } from "../../db";
import { readEventsOfKind } from "../../events/testing";
import { ProviderAccountProbes, providerAccountRepository } from "../../provider-accounts";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  KEY_KIND,
  MACHINE_KIND,
  runWithAccounts,
  TOKEN_KIND,
  type AccountServices,
} from "../../provider-accounts/testing";
import { RunnerConnections, type Answer } from "../../runners";
import { buildProviderAccountOwner, Secrets } from "../../secrets";
import { ProviderAccountProbing, ProviderAccountProbingLayer } from "./probing";
import {
  ProviderAccountRunnerOperations,
  ProviderAccountRunnerOperationsLayer,
} from "./runner-operations";

/** The accounts the default assistant was asked for, in order. */
const defaultAssistantFor: Array<string | undefined> = [];

/** The kind of actor that was current for each of those requests. */
const defaultAssistantActors: Array<string> = [];

/**
 * Stands in for the assistant service and records who asked for the default
 * assistant. What the default assistant does is tested over HTTP, with the
 * real service, in `providerAccount.create creates the default assistant`.
 */
const AssistantStub = Layer.mock(AssistantService)({
  createDefaultIfNone: (providerAccountId?: string) =>
    Effect.flatMap(CurrentActor, (actor) =>
      Effect.sync(() => {
        defaultAssistantFor.push(providerAccountId);
        defaultAssistantActors.push(actor._tag);
      }),
    ),
});

/** Runs when the stubbed runner receives a probe, before it answers: the world changes while a probe is out. */
const whileProbing: { current: Effect.Effect<void> } = { current: Effect.void };

beforeEach(() => {
  whileProbing.current = Effect.void;
  defaultAssistantFor.length = 0;
  defaultAssistantActors.length = 0;
});

const MISSING = "0199e0e7-9999-7000-8000-000000000000";

const withService = <A, E, R>(
  body: (service: ProviderAccountRunnerOperations["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(ProviderAccountRunnerOperations, body).pipe(
    Effect.provide(
      ProviderAccountRunnerOperationsLayer.pipe(
        Layer.provideMerge(ProviderAccountProbingLayer),
        Layer.provide(AssistantStub),
      ),
    ),
  );

describe("providerAccount.signIn", () => {
  it("is refused with InvalidState for a key account, which has nothing to sign in to", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.signIn({ id: added.id, runnerId: runner })),
        );
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("no sign-in step") as unknown,
      },
    });
  });

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.signIn({ id: MISSING, runnerId: runner })),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it("starts the login with its method, and never with the credential of a token account", async () => {
    const outcome = await withStubbedRunner(answerWith({ ok: true }), (service, sent) =>
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const token = yield* addAccount({ kind: TOKEN_KIND, label: "tok" });
        const machine = yield* addAccount({ kind: MACHINE_KIND });
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          secrets.set(buildProviderAccountOwner(token.id), "token", Redacted.make("old-token")),
        );
        yield* service.signIn({ id: token.id, runnerId: runner });
        yield* service.signIn({ id: machine.id, runnerId: runner });
        return sent.filter((request) => request._tag === "loginStart");
      }),
    );

    expect(outcome.map((frame) => frame.method)).toEqual(["create-token", "sign-in"]);
    for (const frame of outcome) {
      expect(frame.harnessAccount).not.toHaveProperty("credential");
      expect(frame.harnessAccount.credentialVariables).toEqual(["ACME_API_KEY"]);
    }
  });
});

describe("providerAccount.submitSignInCode", () => {
  it("is refused with InvalidState for a key account, before the runner is asked", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const added = yield* addAccount({ kind: KEY_KIND });
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.submitSignInCode({ id: added.id, runnerId: runner, code: "abc" })),
        );
      }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("no sign-in step") as unknown,
      },
    });
  });

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await runWithAccounts(
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        return yield* withService((service) =>
          Effect.flip(service.submitSignInCode({ id: MISSING, runnerId: runner, code: "abc" })),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});

/** The frame of a request the controller sent to the stubbed runner. */
type SentRequest = Parameters<RunnerConnections["Service"]["asked"]>[1];

/**
 * Runs `body` with the operations on a runner that answers each request as
 * `answer` says, and records the requests. Probes are stored by the real
 * domain, so a snapshot arrives as it does from a runner.
 */
const withStubbedRunner = <A, E>(
  answer: (request: SentRequest) => Answer,
  body: (
    service: ProviderAccountRunnerOperations["Service"],
    sent: ReadonlyArray<SentRequest>,
  ) => Effect.Effect<A, E, AccountServices | ProviderAccountProbing>,
) => {
  const sent: Array<SentRequest> = [];
  const stubbed = Layer.effect(RunnerConnections)(
    Effect.map(RunnerConnections, (real) => ({
      ...real,
      asked: (_id: string, request: SentRequest) => {
        sent.push(request);
        const answered = Effect.succeed(Option.some(answer(request)));
        return request._tag === "probeRequest"
          ? Effect.andThen(whileProbing.current, answered)
          : answered;
      },
    })),
  );
  return runWithAccounts(
    Effect.gen(function* () {
      const service = yield* ProviderAccountRunnerOperations;
      return yield* body(service, sent);
    }).pipe(
      Effect.provide(
        ProviderAccountRunnerOperationsLayer.pipe(
          Layer.provideMerge(ProviderAccountProbingLayer),
          Layer.provide(stubbed),
          Layer.provide(AssistantStub),
        ),
      ),
    ),
  );
};

const SIGNED_IN_RESULT: ProbeResult = {
  harnessVersion: "1.0.0",
  auth: { status: "ok", identity: "someone@example.com" },
  models: [{ slug: "model-1", name: "Model 1", imageInput: null, options: [] }],
  usage: null,
};

/** Answers the sign-in and probe frames: the login result is `login`, the probe is `probe`. */
const answerWith =
  (
    login: { ok: boolean; token?: string },
    probe: ProbeResult = SIGNED_IN_RESULT,
    deviceCode?: string,
  ) =>
  (request: SentRequest): Answer => {
    switch (request._tag) {
      case "loginStart":
        return {
          _tag: "loginUrl",
          requestId: request.requestId,
          url: "https://login.test/x",
          ...(deviceCode === undefined ? {} : { userCode: deviceCode }),
        };
      case "loginCode":
        return { _tag: "loginResult", requestId: request.requestId, ...login };
      case "probeRequest":
        return {
          _tag: "probeReport",
          requestId: request.requestId,
          providerAccountId: request.harnessAccount.providerAccountId,
          result: probe,
        };
      default:
        throw new Error(`unexpected request ${request._tag}`);
    }
  };

const readToken = (accountId: string) =>
  Effect.flatMap(Secrets, (secrets) =>
    Effect.map(secrets.get(buildProviderAccountOwner(accountId), "token"), (found) =>
      Option.map(found, Redacted.value),
    ),
  );

describe("providerAccount.submitSignInCode for a token account", () => {
  it("stores the token with its expiry, probes with it before answering, and keeps it out of the audit", async () => {
    const outcome = await withStubbedRunner(
      answerWith({ ok: true, token: "tok-secret" }),
      (service, sent) =>
        Effect.gen(function* () {
          const runner = yield* addRunner("laptop");
          const added = yield* addAccount({ kind: TOKEN_KIND });
          const account = yield* service.submitSignInCode({
            id: added.id,
            runnerId: runner,
            code: "abc",
          });
          return {
            account,
            token: yield* readToken(added.id),
            probe: sent.find((request) => request._tag === "probeRequest"),
            audit: yield* readEventsOfKind("providerAccount.signedIn"),
          };
        }),
    );

    expect(outcome.token).toEqual(Option.some("tok-secret"));
    expect(outcome.account.expiresAt).not.toBeNull();
    expect(outcome.account.snapshots[0]?.auth.status).toBe("ok");
    expect(outcome.probe).toMatchObject({
      harnessAccount: { credential: { variable: "ACME_API_KEY", value: "tok-secret" } },
    });
    expect(outcome.audit).toHaveLength(1);
    expect(JSON.stringify(outcome.audit)).not.toContain("tok-secret");
    expect(JSON.stringify(outcome.account)).not.toContain("tok-secret");
  });

  it("fails InvalidState with the snapshot's message when the probe does not find the account signed in, and keeps the sign-in recorded", async () => {
    const message = "Signed in as a@x.com; this account is b@x.com. Sign in again as b@x.com.";
    const outcome = await withStubbedRunner(
      answerWith(
        { ok: true, token: "tok-secret" },
        { ...SIGNED_IN_RESULT, auth: { status: "unauthenticated", message } },
      ),
      (service) =>
        Effect.gen(function* () {
          const runner = yield* addRunner("laptop");
          const added = yield* addAccount({ kind: TOKEN_KIND });
          const failure = yield* Effect.flip(
            service.submitSignInCode({ id: added.id, runnerId: runner, code: "abc" }),
          );
          return { failure, audit: yield* readEventsOfKind("providerAccount.signedIn") };
        }),
    );

    expect(outcome.failure).toMatchObject({ error: { code: "invalid_state", message } });
    expect(outcome.audit).toHaveLength(1);
    // Not ready: no assistant is bound to an account that is not signed in.
    expect(defaultAssistantFor).toEqual([]);
  });
});

describe("providerAccount.submitSignInCode for a per-machine account", () => {
  it("refuses a token the runner returned, and stores nothing", async () => {
    const outcome = await withStubbedRunner(
      answerWith({ ok: true, token: "tok-secret" }),
      (service, sent) =>
        Effect.gen(function* () {
          const runner = yield* addRunner("laptop");
          const added = yield* addAccount({ kind: MACHINE_KIND });
          const failure = yield* Effect.flip(
            service.submitSignInCode({ id: added.id, runnerId: runner, code: "abc" }),
          );
          return {
            failure,
            token: yield* readToken(added.id),
            probes: sent.filter((request) => request._tag === "probeRequest"),
            audit: yield* readEventsOfKind("providerAccount.signedIn"),
          };
        }),
    );

    expect(outcome.failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(JSON.stringify(outcome.failure)).not.toContain("tok-secret");
    expect(outcome.token).toEqual(Option.none());
    expect(outcome.probes).toEqual([]);
    expect(outcome.audit).toEqual([]);
  });

  it("answers the account with its fresh snapshot when the login worked, and creates the default assistant on it", async () => {
    const outcome = await withStubbedRunner(answerWith({ ok: true }), (service) =>
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const added = yield* addAccount({ kind: MACHINE_KIND });
        return {
          added,
          account: yield* service.submitSignInCode({
            id: added.id,
            runnerId: runner,
            code: "abc",
          }),
        };
      }),
    );

    expect(outcome.account.expiresAt).toBeNull();
    expect(outcome.account.snapshots[0]).toMatchObject({ harnessId: ALPHA_HARNESS_ID });
    expect(defaultAssistantFor).toEqual([outcome.added.id]);
  });
});

describe("a sign-in checked while the account changes", () => {
  /** An account that is Alice's, with Alice's `ok` snapshot cached on `runner`, and a second runner. */
  const arrangeAliceCachedOnRunner = Effect.gen(function* () {
    const accounts = yield* providerAccountRepository;
    const sql = yield* SqlClient.SqlClient;
    const runner = yield* addRunner("laptop");
    const other = yield* addRunner("desktop");
    const added = yield* addAccount({ kind: MACHINE_KIND });
    yield* withTransaction(
      sql,
      accounts.setIdentityIfUnset(
        added.id,
        "alice@example.com",
        undefined,
        "2026-10-31T00:00:00.000Z",
      ),
    );
    yield* addSnapshot(added.id, ALPHA_HARNESS_ID, runner, {
      ...SIGNED_IN_RESULT,
      auth: { status: "ok", identity: "alice@example.com" },
    });
    return { runner, other, added };
  });

  const readSnapshotAuth = (accountId: string, runnerId: string) =>
    Effect.gen(function* () {
      const accounts = yield* providerAccountRepository;
      const stored = yield* accounts.readSnapshot(accountId, ALPHA_HARNESS_ID, runnerId);
      return Option.getOrThrow(stored).auth;
    });

  it("marks the runner's cached snapshot as not signed in as soon as the sign-in is accepted, so the runner is not placeable while the sign-in is checked", async () => {
    const seen: Array<unknown> = [];
    const aliceProbe: ProbeResult = {
      ...SIGNED_IN_RESULT,
      auth: { status: "ok", identity: "alice@example.com" },
    };
    const outcome = await withStubbedRunner(answerWith({ ok: true }, aliceProbe), (service) =>
      Effect.gen(function* () {
        const { runner, added } = yield* arrangeAliceCachedOnRunner;
        const sql = yield* SqlClient.SqlClient;
        whileProbing.current = Effect.flatMap(readSnapshotAuth(added.id, runner), (auth) =>
          Effect.sync(() => {
            seen.push(auth);
          }),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie);
        yield* service.submitSignInCode({ id: added.id, runnerId: runner, code: "abc" });
        return yield* readSnapshotAuth(added.id, runner);
      }),
    );

    expect(seen).toEqual([
      {
        status: "unauthenticated",
        identity: "alice@example.com",
        message: "Checking the sign-in…",
      },
    ]);
    expect(outcome.status).toBe("ok");
  });

  it("does not take the runner's cached ok for the sign-in when the account changes during both probes", async () => {
    const outcome = await withStubbedRunner(answerWith({ ok: true }), (service) =>
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const { runner, other, added } = yield* arrangeAliceCachedOnRunner;
        // Another runner's sign-in is accepted while each of this runner's probes is out.
        whileProbing.current = Effect.orDie(
          probes.acceptDeviceSignIn(added.id, other, ALPHA_HARNESS_ID),
        );
        const failure = yield* Effect.flip(
          service.submitSignInCode({ id: added.id, runnerId: runner, code: "abc" }),
        );
        return { failure, auth: yield* readSnapshotAuth(added.id, runner) };
      }),
    );

    expect(outcome.failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: "The account changed while this sign-in was checked. Sign in again.",
      },
    });
    expect(outcome.auth).toMatchObject({
      status: "unauthenticated",
      message: "Checking the sign-in…",
    });
    expect(defaultAssistantFor).toEqual([]);
  });
});

describe("a device sign-in that the runner reports as ended", () => {
  /** Starts a device login as the user, then has the runner report its end with nobody calling. */
  const signInAndEnd = (probe: ProbeResult) =>
    withStubbedRunner(answerWith({ ok: true }, probe, "ABCD-1234"), (service, sent) =>
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const runner = yield* addRunner("laptop");
        const added = yield* addAccount({ kind: MACHINE_KIND });
        yield* service.signIn({ id: added.id, runnerId: runner });
        const started = sent.find((request) => request._tag === "loginStart");
        yield* probing
          .probeAfterLoginEnd(runner, started?.requestId ?? "")
          .pipe(Effect.provideService(CurrentActor, { _tag: "none" }));
        return added;
      }),
    );

  it("creates the default assistant, as the actor that started the sign-in", async () => {
    const added = await signInAndEnd(SIGNED_IN_RESULT);

    expect(defaultAssistantFor).toEqual([added.id]);
    expect(defaultAssistantActors).toEqual(["user"]);
  });

  it("fails InvalidState, and creates no assistant, when the account changes during both probes", async () => {
    const failure = await withStubbedRunner(
      answerWith({ ok: true }, SIGNED_IN_RESULT, "ABCD-1234"),
      (service, sent) =>
        Effect.gen(function* () {
          const probing = yield* ProviderAccountProbing;
          const probes = yield* ProviderAccountProbes;
          const runner = yield* addRunner("laptop");
          const other = yield* addRunner("desktop");
          const added = yield* addAccount({ kind: MACHINE_KIND });
          yield* service.signIn({ id: added.id, runnerId: runner });
          const started = sent.find((request) => request._tag === "loginStart");
          whileProbing.current = Effect.orDie(
            probes.acceptDeviceSignIn(added.id, other, ALPHA_HARNESS_ID),
          );
          return yield* Effect.flip(
            probing
              .probeAfterLoginEnd(runner, started?.requestId ?? "")
              .pipe(Effect.provideService(CurrentActor, { _tag: "none" })),
          );
        }),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("Sign in again") as unknown,
      },
    });
    expect(defaultAssistantFor).toEqual([]);
  });

  it("creates no assistant when the probe does not find the account signed in", async () => {
    await signInAndEnd({ ...SIGNED_IN_RESULT, auth: { status: "unauthenticated" } });

    expect(defaultAssistantFor).toEqual([]);
  });
});

describe("providerAccount.create", () => {
  it("probes the new account on the runners without waiting, when it came with a key", async () => {
    const outcome = await withStubbedRunner(answerWith({ ok: true }), (service, sent) =>
      Effect.gen(function* () {
        yield* addRunner("laptop");
        const created = yield* service.create({
          providerId: "acme/acme",
          kind: KEY_KIND,
          credentials: { apiKey: "sk-1" },
        });
        // The sweep runs on a fiber of its own; give it a moment.
        for (let attempt = 0; attempt < 50 && sent.length === 0; attempt++) {
          yield* Effect.sleep("20 millis");
        }
        const accounts = yield* providerAccountRepository;
        return { created, sent: [...sent], stored: yield* accounts.one(created.id) };
      }),
    );

    expect(outcome.sent).toHaveLength(1);
    expect(outcome.sent[0]).toMatchObject({
      _tag: "probeRequest",
      harnessAccount: {
        providerAccountId: outcome.created.id,
        credential: { value: "sk-1" },
      },
    });
    expect(defaultAssistantFor).toEqual([outcome.created.id]);
  });

  it("creates no default assistant and sends nothing for an account that signs in, which is not ready yet", async () => {
    const outcome = await withStubbedRunner(answerWith({ ok: true }), (service, sent) =>
      Effect.gen(function* () {
        yield* addRunner("laptop");
        const created = yield* service.create({ providerId: "acme/acme", kind: MACHINE_KIND });
        yield* Effect.sleep("100 millis");
        return { created, sent: [...sent] };
      }),
    );

    expect(outcome.created.kind).toBe(MACHINE_KIND);
    expect(defaultAssistantFor).toEqual([]);
    expect(outcome.sent).toEqual([]);
  });
});
