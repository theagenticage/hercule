/**
 * Tests the `TextGeneration` service against a real controller and fake
 * runners on the real runner socket. The frames that cross the socket, the
 * audit entries and the status `controller.read` shows are what they check.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect, Redacted } from "effect";
import type { ControllerInfo } from "@hercule/contract";
import type {
  ModelDescriptor,
  RunnerFacts,
  TextGenerationOutcome,
  TextGenerationRequest,
} from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { SYSTEM_ACTOR } from "../../actor";
import { uuidFromString, withTransaction } from "../../db";
import { get, send } from "../../http/testing";
import { buildProviderAccountOwner } from "../../secrets";
import {
  findProviderAccountId,
  waitForFrames,
  waitForRunnerGone,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
  type FleetOptions,
} from "../../sessions/testing";
import {
  TextGeneration,
  TextGenerationError,
  type TextGenerationCall,
} from "../../text-generation";
import { buildTextGenerationPlugins } from "../../text-generation/testing";

const SECRET_INSTRUCTIONS = "Name the thread in four words";
const SECRET_INPUT = "the user pasted a private key here";
const TITLE = "Fix the login bug";

/**
 * The three providers `automatic` tries, each suggesting a model of its own,
 * and the harness that runs each, named like the shipped ones.
 */
const buildPlugins = (): ReadonlyArray<Plugin> => buildTextGenerationPlugins();

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  harnesses: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["codex/codex", "pi/pi", "claude-code/claude-code"],
  identityPort: 4939,
};

const buildModels = (...slugs: ReadonlyArray<string>): ReadonlyArray<ModelDescriptor> =>
  slugs.map((slug, index) => ({
    slug,
    name: slug,
    imageInput: { maxBytes: null },
    isDefault: index === 0,
    options: [],
  }));

/** Every suggested model, so `automatic` picks codex. */
const ALL_MODELS = buildModels("codex-mini", "pi-small", "haiku");

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withFleet = (
  body: (arranged: Arranged) => Promise<void>,
  options: Partial<FleetOptions> = {},
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: buildPlugins(),
    facts: FACTS,
    models: ALL_MODELS,
    textGenerationDeadline: Duration.seconds(5),
    ...options,
  });

const TITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

const buildCall = (overrides: Partial<TextGenerationCall> = {}): TextGenerationCall => ({
  caller: "core:sessions",
  purpose: "thread.title",
  instructions: SECRET_INSTRUCTIONS,
  input: SECRET_INPUT,
  outputSchema: TITLE_SCHEMA,
  whenNoRunner: "fail",
  ...overrides,
});

type Generated =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: TextGenerationError };

/** Makes one text generation as the controller's own code would, and returns what it ended in. */
const generate = async (
  arranged: Arranged,
  call: TextGenerationCall = buildCall(),
): Promise<Generated> => {
  const exit = await arranged.harness.runWithLiveSessions(
    Effect.flatMap(TextGeneration, (service) =>
      Effect.match(service.generate(call), {
        onSuccess: (value): Generated => ({ ok: true, value }),
        onFailure: (error): Generated => ({ ok: false, error }),
      }),
    ),
  );
  if (exit._tag !== "Success") throw new Error(`the text generation died: ${String(exit.cause)}`);
  return exit.value;
};

const OK: TextGenerationOutcome = {
  outcome: "ok",
  value: { title: TITLE },
  usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.002 },
};

const answerOk = (arranged: Arranged): void => arranged.wire.setTextGenerationAnswer(() => OK);

const setModel = async (arranged: Arranged, model: unknown): Promise<Response> =>
  send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { controller: { "textGeneration.model": model } },
    token: arranged.token,
  });

const readStatus = async (arranged: Arranged): Promise<ControllerInfo["textGeneration"]> => {
  const response = await get(arranged.harness.base, "/api/v1/controller", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as ControllerInfo).textGeneration;
};

const requestsOn = (arranged: Arranged): ReadonlyArray<TextGenerationRequest> =>
  arranged.wire.frames.filter(
    (frame): frame is TextGenerationRequest => frame._tag === "textGenerationRequest",
  );

/** Marks a runner's login as expired in the stored snapshots, as a probe would. */
const logOut = (arranged: Arranged, runnerId: string): Promise<unknown> =>
  Effect.runPromise(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.sql`UPDATE capability_snapshots SET auth_status = 'unauthenticated'
           WHERE runner_id = ${uuidFromString(runnerId)}`,
    ).pipe(Effect.orDie),
  );

/** Marks the login of one Provider Account as expired, on every runner, as a probe would. */
const logOutAccount = (arranged: Arranged, providerAccountId: string): Promise<unknown> =>
  Effect.runPromise(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.sql`UPDATE capability_snapshots SET auth_status = 'unauthenticated'
           WHERE provider_account_id = ${uuidFromString(providerAccountId)}`,
    ).pipe(Effect.orDie),
  );

const reserve = (arranged: Arranged, runnerId: string): Promise<unknown> =>
  Effect.runPromise(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.sql`UPDATE runners SET reserved = 1 WHERE id = ${uuidFromString(runnerId)}`,
    ).pipe(Effect.orDie),
  );

describe("a text generation that succeeds", () => {
  it("returns the decoded value, and sends the runner the harness, the account's home, the model and the schema", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);

      const result = await generate(arranged);

      expect(result).toEqual({ ok: true, value: { title: TITLE } });
      const [request] = await waitForFrames<TextGenerationRequest>(
        arranged.wire,
        "textGenerationRequest",
        1,
      );
      expect(request).toMatchObject({
        harnessId: "codex/codex",
        harnessAccount: {
          providerAccountId: findProviderAccountId(arranged, "codex/codex"),
          harnessHome: `providers/homes/${findProviderAccountId(arranged, "codex/codex")}/codex/codex`,
          modelArgument: "{model}",
        },
        spec: {
          model: "codex-mini",
          instructions: SECRET_INSTRUCTIONS,
          input: SECRET_INPUT,
          outputSchema: TITLE_SCHEMA,
        },
      });
    });
  });

  it("shows no reason why a call cannot run while a runner can take one", async () => {
    await withFleet(async (arranged) => {
      expect((await readStatus(arranged)).unavailableReason).toBeNull();
    });
  });

  it("records a run's call under the run, with the step id as its purpose", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);

      await generate(arranged, buildCall({ caller: "run:run-1", purpose: "screen" }));

      const [entry] = await arranged.harness.audit("textGeneration.completed");
      expect(entry!.payload).toMatchObject({ caller: "run:run-1", purpose: "run-1/screen" });
    });
  });

  it("writes one audit entry with the purpose, the runner, the usage and never the text", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);

      await generate(arranged);

      const entries = await arranged.harness.audit("textGeneration.completed");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.actor).toBe(SYSTEM_ACTOR);
      expect(entries[0]!.payload).toEqual({
        purpose: "sessions/thread.title",
        caller: "core:sessions",
        providerAccountId: findProviderAccountId(arranged, "codex/codex"),
        harnessId: "codex/codex",
        model: "codex-mini",
        runnerId: arranged.runnerId,
        durationMs: expect.any(Number) as unknown,
        usage: { inputTokens: 12, outputTokens: 3 },
        costUsd: 0.002,
      });
      const written = JSON.stringify(entries[0]);
      for (const text of [SECRET_INSTRUCTIONS, SECRET_INPUT, TITLE]) {
        expect(written).not.toContain(text);
      }
      expect(await arranged.harness.audit("textGeneration.failed")).toEqual([]);
    });
  });

  it("clears the last failure", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({
        outcome: "failed",
        message: "not logged in",
      }));
      await generate(arranged);
      expect((await readStatus(arranged)).lastFailure).toMatchObject({ reason: "failed" });

      answerOk(arranged);
      await generate(arranged);

      expect((await readStatus(arranged)).lastFailure).toBeNull();
    });
  });
});

describe("the last failure after the model setting changes", () => {
  it("is not shown for another model", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({
        outcome: "failed",
        message: "not logged in",
      }));
      await generate(arranged);
      expect((await readStatus(arranged)).lastFailure).toMatchObject({ reason: "failed" });

      const pi = findProviderAccountId(arranged, "pi/pi");
      expect((await setModel(arranged, { providerAccountId: pi, model: "haiku" })).status).toBe(
        200,
      );

      expect((await readStatus(arranged)).lastFailure).toBeNull();
    });
  });

  it("is not shown when automatic starts resolving to another model", async () => {
    await withFleet(async (arranged) => {
      const codex = findProviderAccountId(arranged, "codex/codex");
      const pi = findProviderAccountId(arranged, "pi/pi");
      arranged.wire.setTextGenerationAnswer(() => ({
        outcome: "failed",
        message: "codex went wrong",
      }));
      await generate(arranged);
      expect(await readStatus(arranged)).toMatchObject({
        model: { providerAccountId: codex, harnessId: "codex/codex", model: "codex-mini" },
        lastFailure: { message: "codex went wrong" },
      });

      await logOutAccount(arranged, codex);

      expect(await readStatus(arranged)).toEqual({
        model: { providerAccountId: pi, harnessId: "pi/pi", model: "pi-small" },
        unavailableReason: null,
        lastFailure: null,
      });
    });
  });

  it("is not shown when a call that started before the change fails after it", async () => {
    await withFleet(async (arranged) => {
      const call = generate(arranged);
      const [request] = await waitForFrames<TextGenerationRequest>(
        arranged.wire,
        "textGenerationRequest",
        1,
      );
      const pi = findProviderAccountId(arranged, "pi/pi");
      expect((await setModel(arranged, { providerAccountId: pi, model: "haiku" })).status).toBe(
        200,
      );

      arranged.wire.send({
        _tag: "textGenerationReport",
        requestId: request!.requestId,
        outcome: { outcome: "failed", message: "not logged in" },
      });
      await call;

      expect((await readStatus(arranged)).lastFailure).toBeNull();
    });
  });
});

describe("a text generation that fails", () => {
  it("reports failed with the runner's message when the harness could not answer", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({
        outcome: "failed",
        message: "codex is not logged in",
      }));

      const result = await generate(arranged);

      expect(result).toMatchObject({
        ok: false,
        error: { reason: "failed", message: "codex is not logged in" },
      });
      const [entry] = await arranged.harness.audit("textGeneration.failed");
      expect(entry!.payload).toMatchObject({
        reason: "failed",
        message: "codex is not logged in",
        runnerId: arranged.runnerId,
      });
      expect(await readStatus(arranged)).toMatchObject({
        lastFailure: { reason: "failed", message: "codex is not logged in" },
      });
    });
  });

  it("reports invalid-output when the runner says the answer did not match, without quoting it", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({
        outcome: "invalid-output",
        reason: `the model said ${SECRET_INPUT}`,
      }));

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "invalid-output" } });
      const [entry] = await arranged.harness.audit("textGeneration.failed");
      expect(JSON.stringify(entry)).not.toContain(SECRET_INPUT);
      expect(JSON.stringify(await readStatus(arranged))).not.toContain(SECRET_INPUT);
    });
  });

  it("reports invalid-output when the runner's value does not match the output schema", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({
        outcome: "ok",
        value: { title: 42 },
        usage: null,
      }));

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "invalid-output" } });
      expect(await arranged.harness.audit("textGeneration.completed")).toEqual([]);
      expect(await arranged.harness.audit("textGeneration.failed")).toHaveLength(1);
    });
  });

  it("times out when the runner never answers, and records it", async () => {
    await withFleet(
      async (arranged) => {
        const result = await generate(arranged);

        expect(result).toMatchObject({ ok: false, error: { reason: "timeout" } });
        const [entry] = await arranged.harness.audit("textGeneration.failed");
        expect(entry!.payload).toMatchObject({ reason: "timeout", runnerId: arranged.runnerId });
        expect(await readStatus(arranged)).toMatchObject({ lastFailure: { reason: "timeout" } });
      },
      { textGenerationDeadline: Duration.millis(300) },
    );
  });
});

describe("text generation switched off", () => {
  it("fails with off, sends nothing and writes no record", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);
      expect((await setModel(arranged, "off")).status).toBe(200);

      const result = await generate(arranged);

      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: "off",
          message: expect.stringContaining("text generation is off") as unknown,
        },
      });
      expect(requestsOn(arranged)).toEqual([]);
      expect(await arranged.harness.audit("textGeneration.failed")).toEqual([]);
      expect(await arranged.harness.audit("textGeneration.completed")).toEqual([]);
      expect(await readStatus(arranged)).toEqual({
        model: null,
        unavailableReason: result.ok ? null : result.error.message,
        lastFailure: null,
      });
    });
  });
});

describe("the model automatic chooses", () => {
  it("prefers OpenAI, then Z.ai, then Anthropic", async () => {
    await withFleet(async (arranged) => {
      expect((await readStatus(arranged)).model).toEqual({
        providerAccountId: findProviderAccountId(arranged, "codex/codex"),
        harnessId: "codex/codex",
        model: "codex-mini",
      });
    });
    await withFleet(
      async (arranged) => {
        expect((await readStatus(arranged)).model).toEqual({
          providerAccountId: findProviderAccountId(arranged, "pi/pi"),
          harnessId: "pi/pi",
          model: "pi-small",
        });
      },
      { models: buildModels("pi-small", "haiku") },
    );
    await withFleet(
      async (arranged) => {
        expect((await readStatus(arranged)).model).toEqual({
          providerAccountId: findProviderAccountId(arranged, "claude-code/claude-code"),
          harnessId: "claude-code/claude-code",
          model: "haiku",
        });
      },
      { models: buildModels("haiku") },
    );
  });

  it("skips an account that is logged out", async () => {
    await withFleet(async (arranged) => {
      // Logs out the OpenAI account alone, by rewriting its rows.
      await Effect.runPromise(
        withTransaction(
          arranged.harness.sql,
          arranged.harness.sql`UPDATE capability_snapshots SET auth_status = 'unauthenticated'
               WHERE provider_account_id = ${uuidFromString(findProviderAccountId(arranged, "codex/codex"))}`,
        ).pipe(Effect.orDie),
      );
      answerOk(arranged);

      const result = await generate(arranged);

      expect(result).toEqual({ ok: true, value: { title: TITLE } });
      expect(requestsOn(arranged)[0]).toMatchObject({
        harnessId: "pi/pi",
        spec: { model: "pi-small" },
      });
    });
  });

  for (const kind of ["offline", "without the capability"] as const) {
    it(`skips an account that only a runner ${kind} has, and runs on one that can take the call`, async () => {
      await withFleet(
        async (arranged) => {
          const other = await arranged.enlist();
          other.wire.setTextGenerationAnswer(() => OK);
          // Codex is signed in on the first runner only. That runner cannot
          // take the call, so `automatic` must go on to pi, which the other
          // runner has.
          await Effect.runPromise(
            withTransaction(
              arranged.harness.sql,
              Effect.gen(function* () {
                const sql = arranged.harness.sql;
                yield* sql`DELETE FROM capability_snapshots
                WHERE provider_account_id = ${uuidFromString(findProviderAccountId(arranged, "codex/codex"))}
                  AND runner_id = ${uuidFromString(other.runnerId)}`;
                if (kind === "offline") {
                  yield* sql`UPDATE runners SET connectivity = 'offline'
                  WHERE id = ${uuidFromString(arranged.runnerId)}`;
                }
              }),
            ).pipe(Effect.orDie),
          );

          expect((await readStatus(arranged)).model).toEqual({
            providerAccountId: findProviderAccountId(arranged, "pi/pi"),
            harnessId: "pi/pi",
            model: "pi-small",
          });
          const result = await generate(arranged);

          expect(result).toEqual({ ok: true, value: { title: TITLE } });
          expect(requestsOn(arranged)).toEqual([]);
          const [entry] = await arranged.harness.audit("textGeneration.completed");
          expect(entry!.payload).toMatchObject({
            runnerId: other.runnerId,
            providerAccountId: findProviderAccountId(arranged, "pi/pi"),
          });
        },
        kind === "offline" ? {} : { capabilities: [] },
      );
    });
  }

  it("fails with unavailable, and records it, when no account offers its provider's suggested model", async () => {
    await withFleet(
      async (arranged) => {
        answerOk(arranged);

        const result = await generate(arranged);

        expect(result).toMatchObject({ ok: false, error: { reason: "unavailable" } });
        expect(requestsOn(arranged)).toEqual([]);
        const [entry] = await arranged.harness.audit("textGeneration.failed");
        expect(entry!.payload).toMatchObject({
          reason: "unavailable",
          providerAccountId: null,
          harnessId: null,
          model: null,
          runnerId: null,
        });
        expect(await readStatus(arranged)).toMatchObject({
          model: null,
          unavailableReason: expect.stringContaining(
            "pick a model in Settings › System",
          ) as unknown,
          lastFailure: { reason: "unavailable" },
        });
      },
      { models: buildModels("something-else") },
    );
  });
});

describe("a model the user chose", () => {
  it("runs on that account and model, in the account's harness", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);
      const pi = findProviderAccountId(arranged, "pi/pi");
      expect((await setModel(arranged, { providerAccountId: pi, model: "haiku" })).status).toBe(
        200,
      );

      await generate(arranged);

      expect(requestsOn(arranged)[0]).toMatchObject({
        harnessId: "pi/pi",
        harnessAccount: { providerAccountId: pi, modelArgument: "zai/{model}" },
        spec: { model: "haiku" },
      });
      expect(await readStatus(arranged)).toMatchObject({
        model: { providerAccountId: pi, harnessId: "pi/pi", model: "haiku" },
      });
    });
  });

  it("never falls back to another account when the chosen one cannot run", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);
      const pi = findProviderAccountId(arranged, "pi/pi");
      expect((await setModel(arranged, { providerAccountId: pi, model: "haiku" })).status).toBe(
        200,
      );
      await Effect.runPromise(
        withTransaction(
          arranged.harness.sql,
          arranged.harness.sql`UPDATE capability_snapshots SET auth_status = 'unauthenticated'
               WHERE provider_account_id = ${uuidFromString(pi)}`,
        ).pipe(Effect.orDie),
      );

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "unavailable" } });
      expect(requestsOn(arranged)).toEqual([]);
    });
  });
});

describe("a chosen account that was deleted", () => {
  it("makes text generation unavailable, says why, and sends nothing", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);
      const pi = findProviderAccountId(arranged, "pi/pi");
      expect((await setModel(arranged, { providerAccountId: pi, model: "pi-small" })).status).toBe(
        200,
      );
      await Effect.runPromise(
        withTransaction(
          arranged.harness.sql,
          arranged.harness.sql`DELETE FROM provider_accounts WHERE id = ${uuidFromString(pi)}`,
        ).pipe(Effect.orDie),
      );

      const result = await generate(arranged);

      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: "unavailable",
          message: expect.stringContaining("was deleted") as unknown,
        },
      });
      expect(requestsOn(arranged)).toEqual([]);
      expect(await readStatus(arranged)).toMatchObject({
        model: null,
        unavailableReason: expect.stringContaining("was deleted") as unknown,
      });
    });
  });
});

describe("which runner makes the call", () => {
  it("prefers the local runner", async () => {
    await withFleet(
      async (arranged) => {
        const other = await arranged.enlist();
        answerOk(arranged);
        other.wire.setTextGenerationAnswer(() => OK);

        await generate(arranged);

        expect(requestsOn(arranged)).toHaveLength(1);
        expect(other.wire.frames.some((frame) => frame._tag === "textGenerationRequest")).toBe(
          false,
        );
      },
      { firstRunnerIsLocal: true },
    );
  });

  it("uses another runner when the local one is logged out", async () => {
    await withFleet(
      async (arranged) => {
        const other = await arranged.enlist();
        other.wire.setTextGenerationAnswer(() => OK);
        await logOut(arranged, arranged.runnerId);

        const result = await generate(arranged);

        expect(result).toEqual({ ok: true, value: { title: TITLE } });
        expect(requestsOn(arranged)).toEqual([]);
        const [entry] = await arranged.harness.audit("textGeneration.completed");
        expect(entry!.payload).toMatchObject({ runnerId: other.runnerId });
      },
      { firstRunnerIsLocal: true },
    );
  });

  it("uses another runner when the local one lacks the capability", async () => {
    await withFleet(
      async (arranged) => {
        const other = await arranged.enlist();
        other.wire.setTextGenerationAnswer(() => OK);

        const result = await generate(arranged);

        expect(result).toEqual({ ok: true, value: { title: TITLE } });
        expect(requestsOn(arranged)).toEqual([]);
      },
      { firstRunnerIsLocal: true, capabilities: [] },
    );
  });

  it("skips a runner whose model list lacks the chosen model", async () => {
    await withFleet(
      async (arranged) => {
        const other = await arranged.enlist();
        other.wire.setTextGenerationAnswer(() => OK);
        const pi = findProviderAccountId(arranged, "pi/pi");
        expect((await setModel(arranged, { providerAccountId: pi, model: "haiku" })).status).toBe(
          200,
        );
        // The local runner no longer lists any model for pi.
        await Effect.runPromise(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`UPDATE capability_snapshots SET models = '[]'
            WHERE provider_account_id = ${uuidFromString(pi)}
              AND runner_id = ${uuidFromString(arranged.runnerId)}`,
          ).pipe(Effect.orDie),
        );

        const result = await generate(arranged);

        expect(result).toEqual({ ok: true, value: { title: TITLE } });
        expect(requestsOn(arranged)).toEqual([]);
        const [entry] = await arranged.harness.audit("textGeneration.completed");
        expect(entry!.payload).toMatchObject({ runnerId: other.runnerId, model: "haiku" });
      },
      { firstRunnerIsLocal: true },
    );
  });

  it("fails with unavailable, and says why in the status, when no runner lists the chosen model", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);
      const pi = findProviderAccountId(arranged, "pi/pi");
      expect(
        (await setModel(arranged, { providerAccountId: pi, model: "not-in-any-list" })).status,
      ).toBe(200);

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "unavailable" } });
      expect((await readStatus(arranged)).unavailableReason).toBe(
        result.ok ? null : result.error.message,
      );
      expect(requestsOn(arranged)).toEqual([]);
      const [entry] = await arranged.harness.audit("textGeneration.failed");
      expect(entry!.payload).toMatchObject({
        providerAccountId: pi,
        harnessId: "pi/pi",
        model: "not-in-any-list",
        runnerId: null,
      });
    });
  });

  it("uses the other runner when there is no local runner", async () => {
    await withFleet(async (arranged) => {
      const other = await arranged.enlist();
      other.wire.setTextGenerationAnswer(() => OK);
      await logOut(arranged, arranged.runnerId);

      const result = await generate(arranged);

      expect(result).toEqual({ ok: true, value: { title: TITLE } });
    });
  });

  it("never uses a reserved runner", async () => {
    await withFleet(async (arranged) => {
      const other = await arranged.enlist();
      other.wire.setTextGenerationAnswer(() => OK);
      await logOut(arranged, arranged.runnerId);
      await reserve(arranged, other.runnerId);

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "unavailable" } });
      expect(other.wire.frames.some((frame) => frame._tag === "textGenerationRequest")).toBe(false);
    });
  });

  it("fails with unavailable when every signed-in runner lacks the capability", async () => {
    await withFleet(
      async (arranged) => {
        const result = await generate(arranged);

        expect(result).toMatchObject({
          ok: false,
          error: {
            reason: "unavailable",
            message: expect.stringContaining("pick a model in Settings › System") as unknown,
          },
        });
      },
      { capabilities: [] },
    );
  });

  it("fails with unavailable when no runner is signed in", async () => {
    await withFleet(async (arranged) => {
      await logOut(arranged, arranged.runnerId);

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "unavailable" } });
      expect(requestsOn(arranged)).toEqual([]);
    });
  });
});

describe("the limit per runner", () => {
  const CALLS = 11;
  const PERMITS = 10;

  it("holds the eleventh call until one of the first ten ends", async () => {
    await withFleet(
      async (arranged) => {
        const calls = Array.from({ length: CALLS }, () => generate(arranged));
        const first = await waitForFrames<TextGenerationRequest>(
          arranged.wire,
          "textGenerationRequest",
          PERMITS,
        );
        // Nothing more arrives while all ten permits are held.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requestsOn(arranged)).toHaveLength(PERMITS);

        arranged.wire.send({
          _tag: "textGenerationReport",
          requestId: first[0]!.requestId,
          outcome: OK,
        });
        await waitForFrames<TextGenerationRequest>(arranged.wire, "textGenerationRequest", CALLS);
        for (const frame of requestsOn(arranged).slice(1)) {
          arranged.wire.send({
            _tag: "textGenerationReport",
            requestId: frame.requestId,
            outcome: OK,
          });
        }

        const results = await Promise.all(calls);
        expect(results.every((one) => one.ok)).toBe(true);
      },
      { textGenerationDeadline: Duration.seconds(20) },
    );
  });

  it("keeps a slot until the runner answers, even after its caller gave up", async () => {
    // The deadline is far from the in-time answer, so a busy machine that
    // delays a timer by half a second still answers the first ten in time.
    const deadlineMs = 1500;
    const inTimeAnswerMs = 100;
    const lateAnswerMs = 2200;
    await withFleet(
      async (arranged) => {
        const answerTimers: Array<ReturnType<typeof setTimeout>> = [];
        const outstanding = new Set<string>();
        let received = 0;
        let mostOutstanding = 0;
        // The first ten answer in time. The eleventh starts after they end, and
        // its answer comes after its caller's deadline.
        arranged.wire.setTextGenerationAnswer((request) => {
          received += 1;
          outstanding.add(request.requestId);
          mostOutstanding = Math.max(mostOutstanding, outstanding.size);
          answerTimers.push(
            setTimeout(
              () => {
                outstanding.delete(request.requestId);
                arranged.wire.send({
                  _tag: "textGenerationReport",
                  requestId: request.requestId,
                  outcome: OK,
                });
              },
              received <= PERMITS ? inTimeAnswerMs : lateAnswerMs,
            ),
          );
          return undefined;
        });
        try {
          const first = await Promise.all(Array.from({ length: CALLS }, () => generate(arranged)));
          expect(first.filter((one) => one.ok)).toHaveLength(PERMITS);
          expect(first[PERMITS]).toMatchObject({ ok: false, error: { reason: "timeout" } });

          // The eleventh call's runner is still working, so its slot is taken.
          await Promise.all(Array.from({ length: PERMITS }, () => generate(arranged)));

          expect(mostOutstanding).toBeLessThanOrEqual(PERMITS);
        } finally {
          for (const timer of answerTimers) clearTimeout(timer);
        }
      },
      { textGenerationDeadline: Duration.millis(deadlineMs) },
    );
  });
});

describe("the key a call sends", () => {
  /** Stores the key of an account the way the account update does, in its own transaction. */
  const storeKey = (arranged: Arranged, providerAccountId: string, value: string): Promise<void> =>
    Effect.runPromise(
      Effect.asVoid(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.secrets.set(
              buildProviderAccountOwner(providerAccountId),
              "apiKey",
              Redacted.make(value),
            ),
          ),
        ),
      ),
    );

  it("is the key stored when the call gets its slot, not the one stored when it queued", async () => {
    await withFleet(
      async (arranged) => {
        const pi = findProviderAccountId(arranged, "pi/pi");
        expect(
          (await setModel(arranged, { providerAccountId: pi, model: "pi-small" })).status,
        ).toBe(200);
        await storeKey(arranged, pi, "the-old-key");
        // No runner answers, so the first ten calls hold every slot.
        const calls = Array.from({ length: 11 }, () => generate(arranged));
        const first = await waitForFrames<TextGenerationRequest>(
          arranged.wire,
          "textGenerationRequest",
          10,
        );
        await storeKey(arranged, pi, "the-new-key");

        arranged.wire.send({
          _tag: "textGenerationReport",
          requestId: first[0]!.requestId,
          outcome: OK,
        });
        const all = await waitForFrames<TextGenerationRequest>(
          arranged.wire,
          "textGenerationRequest",
          11,
        );

        expect(all[10]!.harnessAccount.credential?.value).toBe("the-new-key");
        for (const frame of all.slice(1)) {
          arranged.wire.send({
            _tag: "textGenerationReport",
            requestId: frame.requestId,
            outcome: OK,
          });
        }
        await Promise.all(calls);
      },
      { textGenerationDeadline: Duration.seconds(20) },
    );
  });
});

describe("a call that the runner cannot finish", () => {
  it("reports timeout when the runner reports that its harness ran too long", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({ outcome: "timeout" }));

      const result = await generate(arranged);

      expect(result).toMatchObject({ ok: false, error: { reason: "timeout" } });
      const [entry] = await arranged.harness.audit("textGeneration.failed");
      expect(entry!.payload).toMatchObject({ reason: "timeout", runnerId: arranged.runnerId });
      expect(await readStatus(arranged)).toMatchObject({
        lastFailure: { reason: "timeout", message: expect.stringMatching(/.+/) as unknown },
      });
    });
  });

  it("reports unavailable, with one record, when the runner disconnects mid-call", async () => {
    await withFleet(async (arranged) => {
      const call = generate(arranged);
      await waitForFrames<TextGenerationRequest>(arranged.wire, "textGenerationRequest", 1);

      arranged.wire.close();

      expect(await call).toMatchObject({
        ok: false,
        error: {
          reason: "unavailable",
          message: expect.stringContaining("connection ended") as unknown,
        },
      });
      expect(await arranged.harness.audit("textGeneration.failed")).toHaveLength(1);
      expect(await arranged.harness.audit("textGeneration.completed")).toEqual([]);
      await waitForRunnerGone(arranged);
      // With its only runner gone, the setting resolves to no model, so the
      // failure of a call that ran on that model is no longer shown.
      expect(await readStatus(arranged)).toMatchObject({ model: null, lastFailure: null });
    });
  });

  it("drops a report with an empty message, closing the runner's connection, and keeps controller.read working", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setTextGenerationAnswer(() => ({ outcome: "failed", message: "" }));

      const result = await generate(arranged);

      // The empty message does not decode, so the controller does not take the
      // report. It closes the connection, which ends the call.
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: "unavailable",
          message: expect.stringContaining("connection ended") as unknown,
        },
      });
      await waitForRunnerGone(arranged);
      expect(await readStatus(arranged)).toMatchObject({ model: null, lastFailure: null });
      const entries = await arranged.harness.audit("textGeneration.failed");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.payload).toMatchObject({
        reason: "unavailable",
        message: expect.stringContaining("connection ended") as unknown,
      });
    });
  });
});

describe("an error nobody expected", () => {
  it("is recorded as failed, with one audit entry and a last failure, and then reaches the caller", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);
      // The Z.ai account holds a key, so the call reads its secret before it
      // sends anything. With the table gone, that read fails in a way no
      // caller can act on.
      const pi = findProviderAccountId(arranged, "pi/pi");
      expect((await setModel(arranged, { providerAccountId: pi, model: "pi-small" })).status).toBe(
        200,
      );
      await Effect.runPromise(
        withTransaction(
          arranged.harness.sql,
          arranged.harness.sql`ALTER TABLE secrets RENAME TO secrets_gone`,
        ).pipe(Effect.orDie),
      );

      const exit = await arranged.harness.runWithLiveSessions(
        Effect.flatMap(TextGeneration, (service) => service.generate(buildCall())),
      );

      expect(exit._tag).toBe("Failure");
      expect(requestsOn(arranged)).toEqual([]);
      const entries = await arranged.harness.audit("textGeneration.failed");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.payload).toMatchObject({
        reason: "failed",
        message: expect.stringMatching(/.+/) as unknown,
      });
      expect(await arranged.harness.audit("textGeneration.completed")).toEqual([]);
      expect(await readStatus(arranged)).toMatchObject({
        lastFailure: { reason: "failed", message: expect.stringMatching(/.+/) as unknown },
      });
    });
  });
});

describe("a caller that gives a schema no harness accepts", () => {
  it("fails as failed, without sending the call", async () => {
    await withFleet(async (arranged) => {
      answerOk(arranged);

      const result = await generate(arranged, {
        ...buildCall(),
        // An object needs additionalProperties: false in the subset.
        outputSchema: { type: "object", properties: {}, required: [] },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: "failed",
          message: expect.stringContaining("outside the JSON Schema subset") as unknown,
        },
      });
      expect(requestsOn(arranged)).toEqual([]);
    });
  });
});
