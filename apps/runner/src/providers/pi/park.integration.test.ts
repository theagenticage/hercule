/**
 * The park against the real pi binary: that a tool call the user has not
 * answered really does stop, and that answering it really does let it run. A
 * fake pi proves what the adapter writes; only the binary proves that
 * the extension is loaded, that its dialog reaches Hercule, and that pi holds the
 * tool until the answer comes back.
 *
 * No paid key and no real model: `models.json` in the throwaway agent directory
 * points the `zai` provider at a local server that answers one fake tool
 * call. The developer's own `~/.pi` is never read or written, and the only
 * process stopped is the one the adapter started.
 *
 * Skips without `pi` on PATH, like the other integration tests here.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { AccessMode, ProviderEvent, SessionSpec } from "@hercule/protocol";
import { pi } from "./adapter";
import { cleanupHomes, contextIn, TEST_ZAI_KEY, SPEC, taggedIn, until } from "./testing";
import { scratchHome } from "../testing";
import {
  PARKED_COMMAND,
  PARKED_OUTPUT,
  startFakeModelServer,
  type FakeModelFirstTurn,
  type FakeModelServer,
} from "./upstream";

const binary = Bun.which("pi") ?? undefined;

const upstreams: Array<FakeModelServer> = [];

afterAll(() => {
  cleanupHomes();
  for (const upstream of upstreams.splice(0)) upstream.stop();
});

const scratch = (): string => scratchHome("pi-park");

const BUDGET_MS = 120_000;

/** Long enough that a tool call that was going to run would have run. */
const UNANSWERED_MS = 2_000;

/**
 * The fake model, standing in for `zai` so the adapter's own
 * `--model zai/<slug>` reaches it. Built-in models stay; `fake-model` is added
 * beside them.
 */
const pointAtFakeModel = (home: string, baseUrl: string): void => {
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        zai: {
          baseUrl,
          api: "openai-completions",
          apiKey: "not-a-real-key",
          models: [
            {
              id: "fake-model",
              name: "Fake model",
              reasoning: true,
              input: ["text"],
              contextWindow: 100_000,
              maxTokens: 4_096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
};

/** The session under test: the fake model, on whichever mode is asked for. */
const specFor = (accessMode: AccessMode): SessionSpec => ({
  ...SPEC,
  modelSelection: { model: "fake-model", options: { thinking: "low" } },
  accessMode,
});

interface Live {
  readonly sessionId: string;
  /** The session's own directory, which is where its files are meant to land. */
  readonly cwd: string;
  readonly seen: Array<ProviderEvent>;
  readonly stop: () => Promise<void>;
}

const running = async (
  firstTurn: FakeModelFirstTurn = {},
  accessMode: AccessMode = "approval-required",
): Promise<Live> => {
  const upstream = startFakeModelServer(firstTurn);
  upstreams.push(upstream);
  const home = scratch();
  pointAtFakeModel(home, upstream.baseUrl);
  const cwd = scratch();
  // The fake upstream reads no credential, and the real binary's own PATH
  // is what finds the shell it runs the command with.
  const ctx = {
    ...contextIn(home, cwd, { zaiApiKey: TEST_ZAI_KEY }),
    binary: binary!,
    env: { PATH: process.env["PATH"] ?? "" },
  };
  const sessionId = crypto.randomUUID();
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(pi.events, (event) =>
      Effect.sync(() => {
        if (event.sessionId === sessionId) seen.push(event);
      }),
    ),
  );
  await Effect.runPromise(pi.startSession(sessionId, specFor(accessMode), ctx));
  await Effect.runPromise(
    pi.sendInput(sessionId, { text: `Run the shell command: ${PARKED_COMMAND}` }),
  );
  return {
    sessionId,
    cwd,
    seen,
    stop: () => Effect.runPromise(pi.stopSession(sessionId, "stopped")),
  };
};

/** Waits on the real binary, and says what the session had reported when it gave up. */
const awaiting = (live: Live, what: string, ready: () => boolean): Promise<void> =>
  until(
    `${what}, having reported ${live.seen.map((event) => event._tag).join(", ")}`,
    ready,
    BUDGET_MS / 2,
  );

const requests = (live: Live): ReadonlyArray<Extract<ProviderEvent, { _tag: "request.opened" }>> =>
  taggedIn(live.seen, "request.opened");

const opened = (live: Live): Extract<ProviderEvent, { _tag: "request.opened" }> | undefined =>
  requests(live)[0];

const endOf = (
  live: Live,
  itemId: string,
): Extract<ProviderEvent, { _tag: "item.completed" }> | undefined =>
  taggedIn(live.seen, "item.completed").find((event) => event.itemId === itemId);

const finishedTheCommand = (live: Live, itemId: string): boolean =>
  endOf(live, itemId) !== undefined;

const finishedTheTurn = (live: Live): boolean => taggedIn(live.seen, "turn.completed").length > 0;

const outputOf = (live: Live, itemId: string): string =>
  taggedIn(live.seen, "content.delta")
    .filter((event) => event.itemId === itemId && event.streamKind === "command_output")
    .map((event) => event.delta)
    .join("");

describe.skipIf(binary === undefined)("a real pi parked on a real tool call", () => {
  it(
    "holds the command until the user allows it, then runs it",
    async () => {
      const live = await running({ command: `echo ${PARKED_OUTPUT} | tee ran.txt` });
      await awaiting(live, "the session was never parked", () => opened(live) !== undefined);
      const request = opened(live)!;

      expect(request.request.kind).toBe("command_approval");
      // Nothing may happen to the tool while the question stands.
      await new Promise((resolve) => setTimeout(resolve, UNANSWERED_MS));
      expect(
        finishedTheCommand(live, request.request.itemId),
        "the command ran without an answer",
      ).toBe(false);
      expect(finishedTheTurn(live), "the turn ended without an answer").toBe(false);

      await Effect.runPromise(
        pi.respondToRequest(live.sessionId, request.request.requestId, "allow"),
      );
      await awaiting(live, "the allowed command never ran", () =>
        finishedTheCommand(live, request.request.itemId),
      );

      expect(outputOf(live, request.request.itemId)).toContain(PARKED_OUTPUT);
      // The command ran where the session runs. A pi started in the runner's
      // own directory would have written this into whatever directory the
      // daemon was launched from.
      expect(existsSync(join(live.cwd, "ran.txt")), "the command ran somewhere else").toBe(true);
      expect(existsSync(join(process.cwd(), "ran.txt"))).toBe(false);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "blocks the command on a deny, so it never runs",
    async () => {
      const marker = join(scratch(), "ran");
      const live = await running({ command: `echo ${PARKED_OUTPUT} > ${marker}` });
      await awaiting(live, "the session was never parked", () => opened(live) !== undefined);
      const request = opened(live)!;

      await Effect.runPromise(
        pi.respondToRequest(live.sessionId, request.request.requestId, "deny"),
      );

      await awaiting(live, "the denied command never ended", () =>
        finishedTheCommand(live, request.request.itemId),
      );
      // The user's own answer, not something that went wrong with the command.
      expect(endOf(live, request.request.itemId)?.status).toBe("declined");
      // Not merely unreported: the command's own side effect is what proves it
      // did not run.
      expect(existsSync(marker), "the denied command ran anyway").toBe(false);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "asks about each call of a batch on that call's own terms",
    async () => {
      const file = join(scratch(), "written.txt");
      const live = await running({ writes: file });
      await awaiting(
        live,
        "the file change was never asked about",
        () => opened(live) !== undefined,
      );
      const first = opened(live)!.request;

      expect(first.kind).toBe("file_change_approval");
      expect(first.detail).toEqual({ paths: [file] });
      // The call is held open for as long as the question stands, which is the
      // item the card overlays.
      expect(finishedTheCommand(live, first.itemId)).toBe(false);
      // One card is docked at a time; the call behind it has not run yet.
      expect(requests(live)).toHaveLength(1);

      await Effect.runPromise(pi.respondToRequest(live.sessionId, first.requestId, "allow"));
      await awaiting(
        live,
        "the second call of the batch was never asked about",
        () => requests(live).length === 2,
      );
      const second = requests(live)[1]!.request;

      // Each question carries its own call, not whatever ran most recently.
      expect(second.itemId).not.toBe(first.itemId);
      expect(second.kind).toBe("command_approval");
      expect(second.detail).toEqual({ command: PARKED_COMMAND });
      await Effect.runPromise(pi.respondToRequest(live.sessionId, second.requestId, "allow"));
      await awaiting(live, "the allowed command never ran", () =>
        finishedTheCommand(live, second.itemId),
      );
      // pi asks for approval of each tool call in a batch one by one, then runs
      // all calls of the batch in parallel. So the file change can land after
      // the command finishes, and the test waits for the file instead of
      // checking once.
      await awaiting(live, "the allowed file change never landed", () => existsSync(file));
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "lets a file change through under auto-accept-edits, and still asks about the command",
    async () => {
      const file = join(scratch(), "written.txt");
      const live = await running({ writes: file }, "auto-accept-edits");
      await awaiting(live, "the command was never asked about", () => opened(live) !== undefined);
      const request = opened(live)!;

      // The mode's whole point: the file change was never docked, and the
      // shell command beside it in the same batch still is the user's to
      // answer. pi holds a whole batch before it runs any of it, so the change
      // itself lands once the command it was batched with is answered.
      expect(requests(live)).toHaveLength(1);
      expect(request.request.kind).toBe("command_approval");
      await Effect.runPromise(
        pi.respondToRequest(live.sessionId, request.request.requestId, "allow"),
      );
      await awaiting(live, "the file change never landed", () => existsSync(file));
      expect(requests(live)).toHaveLength(1);
      await live.stop();
    },
    BUDGET_MS,
  );

  it(
    "cancels the question and ends the turn when the session is interrupted",
    async () => {
      const live = await running();
      await awaiting(live, "the session was never parked", () => opened(live) !== undefined);
      const request = opened(live)!;

      await Effect.runPromise(pi.interrupt(live.sessionId));

      await awaiting(live, "the park never ended", () =>
        live.seen.some(
          (event) =>
            event._tag === "request.resolved" &&
            event.requestId === request.request.requestId &&
            event.decision === "cancel",
        ),
      );
      await awaiting(live, "the turn never ended", () =>
        live.seen.some((event) => event._tag === "turn.completed" && event.state === "interrupted"),
      );
      await live.stop();
    },
    BUDGET_MS,
  );
});
