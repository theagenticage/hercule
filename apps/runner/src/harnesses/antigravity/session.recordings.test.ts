/**
 * Plays recordings of a real `agy` through an Antigravity session, the way a
 * user drives one. A fake `agy` replays what the real one sent in answer to
 * each client message. The test drives the adapter's own interface the way
 * the recorded scenario did: `sendInput` for each prompt, an approval or an
 * answer where the recording shows the client gave one, and `interrupt` where
 * it sent `session/cancel`. It then checks the whole event stream, and that
 * the session wrote to `agy` what the recorded client wrote.
 *
 * Not played:
 * - The three-prompt `question-variants` stops after two prompts: its third
 *   prompt is answered with `decline`, which the session sends only for a
 *   question nobody can answer, and no input of the adapter's interface asks
 *   for it.
 * - `deny-cancelled-followup` answers the request with the outcome `cancelled`
 *   and then sends its own follow-up, with no `session/cancel`. The session's
 *   `cancel` decision also sends `session/cancel` and sends no follow-up, so
 *   it cannot write what the recorded client wrote.
 *
 * `normalize.recordings.test.ts` plays every other recording through the
 * normalizer alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { readRecording, type JsonRpcMessage, type RecordingName } from "@hercule/acp/testing";
import type { HarnessEvent, QuestionAnswers, SessionSpec } from "@hercule/protocol";
import type { ApprovalDecision } from "@hercule/protocol";
import { cleanupHomes, CWD, settle, waitUntil } from "../testing";
import { makeAntigravityAdapter } from "./adapter";
import { expectEventStreamToHoldTogether } from "./event-stream.testing";
import { buildFakeAgy, buildStartContext, createSignedInHome } from "./fake-agy.testing";

afterEach(cleanupHomes);

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const ACCOUNT = "0199e0e7-0000-7000-8000-00000000000a";

const SPEC: SessionSpec = {
  providerAccountId: ACCOUNT,
  workspaceId: null,
  modelSelection: { model: "gemini-4-neon", options: { effort: "high" } },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/** What the user does while a turn runs. */
type Action =
  | { readonly decide: ApprovalDecision }
  | { readonly answer: QuestionAnswers }
  /** Interrupts once `ready` holds, which is what the recording waited for before it cancelled. */
  | { readonly interrupt: (events: ReadonlyArray<HarnessEvent>) => boolean };

/** One input of the user: the recorded prompts its turn sent (the first is the input, the rest follow-ups), and what the user does. */
interface Input {
  readonly prompts: ReadonlyArray<number>;
  readonly actions: ReadonlyArray<Action>;
  readonly modelSelection?: SessionSpec["modelSelection"];
  readonly end: "completed" | "interrupted";
}

interface Scenario {
  readonly recording: RecordingName;
  readonly accessMode?: SessionSpec["accessMode"];
  readonly inputs: ReadonlyArray<Input>;
  /** The positions, among the recorded client's replies, of the replies to prompts the scenario does not play. */
  readonly unplayedReplies?: ReadonlyArray<number>;
}

const toolStarted = (events: ReadonlyArray<HarnessEvent>) =>
  events.some((event) => event._tag === "item.started" && event.kind !== "assistant_message");

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    recording: "basic-allow",
    inputs: [{ prompts: [0], actions: [{ decide: "allow" }], end: "completed" }],
  },
  {
    recording: "two-requests",
    inputs: [
      { prompts: [0], actions: [{ decide: "allow" }, { decide: "allow" }], end: "completed" },
    ],
  },
  {
    // The session follows a denial with a prompt of its own, in the same turn.
    recording: "deny-followup",
    inputs: [{ prompts: [0, 1], actions: [{ decide: "deny" }], end: "completed" }],
  },
  {
    recording: "cancel-during-permission",
    inputs: [
      {
        prompts: [0],
        actions: [
          {
            interrupt: (events) => events.some((event) => event._tag === "request.opened"),
          },
        ],
        end: "interrupted",
      },
    ],
  },
  {
    recording: "interrupt-running",
    accessMode: "full-access",
    inputs: [{ prompts: [0], actions: [{ interrupt: toolStarted }], end: "interrupted" }],
  },
  {
    recording: "question-variants",
    unplayedReplies: [2],
    inputs: [
      { prompts: [0], actions: [{ answer: { "Question 1": "Red" } }], end: "completed" },
      { prompts: [1], actions: [{ answer: { Question: "Purple" } }], end: "completed" },
    ],
  },
  {
    recording: "model-switch",
    inputs: [
      {
        prompts: [0],
        actions: [],
        modelSelection: { model: "gemini-4-carbon", options: { effort: "low" } },
        end: "completed",
      },
    ],
  },
  {
    recording: "nonzero-exit",
    accessMode: "full-access",
    inputs: [{ prompts: [0], actions: [], end: "completed" }],
  },
  {
    recording: "background-command",
    accessMode: "full-access",
    inputs: [{ prompts: [0], actions: [], end: "completed" }],
  },
];

const summarize = ({ id, result, method }: JsonRpcMessage) => ({ id, result, method });

const sortReplies = (replies: ReadonlyArray<ReturnType<typeof summarize>>) =>
  replies.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const isPrompt = (message: JsonRpcMessage) => message.method === "session/prompt";

/** The texts of the prompts the recorded client sent, in order. */
const readRecordedPrompts = (name: RecordingName): ReadonlyArray<string> =>
  readRecording(name)
    .filter(({ direction, message }) => direction === "out" && isPrompt(message))
    .map(({ message }) => (message.params as { prompt: Array<{ text: string }> }).prompt[0]!.text);

/** The usage in the reply to the recorded prompt with this index, as `turn.completed` reports it. */
const readRecordedUsage = (name: RecordingName, promptIndex: number) => {
  const promptId = readRecording(name).filter(
    ({ direction, message }) => direction === "out" && isPrompt(message),
  )[promptIndex]!.message.id;
  const usage = (
    readRecording(name).find(
      ({ direction, message }) =>
        direction === "in" && message.method === undefined && message.id === promptId,
    )!.message.result as {
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens: number;
        cachedWriteTokens: number;
      };
    }
  ).usage;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedReadTokens,
    cacheWriteTokens: usage.cachedWriteTokens,
  };
};

const sumUsage = (parts: ReadonlyArray<ReturnType<typeof readRecordedUsage>>) => ({
  inputTokens: parts.reduce((sum, part) => sum + part.inputTokens, 0),
  outputTokens: parts.reduce((sum, part) => sum + part.outputTokens, 0),
  cacheReadTokens: parts.reduce((sum, part) => sum + part.cacheReadTokens, 0),
  cacheWriteTokens: parts.reduce((sum, part) => sum + part.cacheWriteTokens, 0),
});

/** The messages the recorded client wrote after its first prompt that answer a request of `agy` or cancel. */
const readRecordedClientReplies = (name: RecordingName): ReadonlyArray<JsonRpcMessage> => {
  const recording = readRecording(name);
  const firstPrompt = recording.findIndex(
    ({ direction, message }) => direction === "out" && isPrompt(message),
  );
  return recording
    .slice(firstPrompt)
    .filter(
      ({ direction, message }) =>
        direction === "out" &&
        (message.result !== undefined || message.method === "session/cancel"),
    )
    .map(({ message }) => message);
};

/** Plays one scenario and returns what the session emitted and what it wrote to `agy`. */
const play = (scenario: Scenario) =>
  Effect.gen(function* () {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, { recording: scenario.recording });
    const adapter = makeAntigravityAdapter(fake);
    const events: HarnessEvent[] = [];
    yield* Effect.forkScoped(
      Stream.runForEach(adapter.events, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
    );
    yield* Effect.promise(settle);
    yield* Effect.addFinalizer(() => adapter.stopSession(SESSION, "stopped"));
    const context = buildStartContext(home, CWD);
    yield* adapter.startSession(
      SESSION,
      { ...SPEC, accessMode: scenario.accessMode ?? SPEC.accessMode },
      context,
    );

    const prompts = readRecordedPrompts(scenario.recording);
    const tags = <Tag extends HarnessEvent["_tag"]>(tag: Tag) =>
      events.filter((event): event is Extract<HarnessEvent, { _tag: Tag }> => event._tag === tag);
    const until = (what: string, ready: () => boolean) =>
      Effect.promise(() => waitUntil(what, ready));
    let opened = 0;
    let finished = 0;
    for (const input of scenario.inputs) {
      yield* adapter.sendInput(SESSION, {
        text: prompts[input.prompts[0]!]!,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
      for (const action of input.actions) {
        if ("interrupt" in action) {
          yield* until("reached the recorded point", () => action.interrupt(events));
          yield* adapter.interrupt(SESSION);
          continue;
        }
        opened += 1;
        yield* until("opened a request", () => tags("request.opened").length === opened);
        const requestId = tags("request.opened")[opened - 1]!.request.requestId;
        yield* "decide" in action
          ? adapter.respondToApprovalRequest(SESSION, requestId, action.decide)
          : adapter.respondToQuestion(SESSION, requestId, action.answer, SPEC.modelSelection);
      }
      finished += 1;
      yield* until("completed the turn", () => tags("turn.completed").length === finished);
    }
    return { events, tags, received: fake.spawns[0]!.harness.received };
  });

describe("recordings of agy through an Antigravity session", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.recording}: the session plays the recorded turns`, () =>
      Effect.runPromise(
        play(scenario).pipe(
          Effect.flatMap(({ events, tags, received }) =>
            Effect.sync(() => {
              expectEventStreamToHoldTogether(events);

              const recorded = readRecordedPrompts(scenario.recording);
              const played = scenario.inputs.flatMap((input) => input.prompts);
              expect(
                received
                  .filter(isPrompt)
                  .map(
                    (message) =>
                      (message.params as { prompt: Array<{ text: string }> }).prompt[0]!.text,
                  ),
                "the session wrote the recorded prompts, follow-ups included",
              ).toEqual(played.map((index) => recorded[index]));

              // The order differs where the recorder cancelled before it answered, so compare as a set.
              const recordedReplies = readRecordedClientReplies(scenario.recording).map(summarize);
              const written = received
                .filter(
                  (message) => message.result !== undefined || message.method === "session/cancel",
                )
                .map(summarize);
              const expectedReplies = recordedReplies.filter(
                (_reply, index) => !(scenario.unplayedReplies ?? []).includes(index),
              );
              expect(sortReplies(written)).toEqual(sortReplies(expectedReplies));

              const turns = tags("turn.completed");
              expect(tags("turn.started"), "one turn per input").toHaveLength(
                scenario.inputs.length,
              );
              expect(turns.map((turn) => turn.state)).toEqual(
                scenario.inputs.map((input) => input.end),
              );
              expect(
                turns.map((turn) => turn.usage),
                "each turn reports the usage of its recorded replies",
              ).toEqual(
                scenario.inputs.map((input) =>
                  sumUsage(
                    input.prompts.map((index) => readRecordedUsage(scenario.recording, index)),
                  ),
                ),
              );

              // Every request is resolved before the turn it belongs to completes.
              for (const opened of tags("request.opened")) {
                const requestId = opened.request.requestId;
                const resolvedAt = events.findIndex(
                  (event) => event._tag === "request.resolved" && event.requestId === requestId,
                );
                const openedAt = events.indexOf(opened);
                const completedAt = events.findIndex(
                  (event, index) => index > openedAt && event._tag === "turn.completed",
                );
                expect(resolvedAt, `request ${requestId} resolves`).toBeGreaterThan(-1);
                expect(
                  resolvedAt,
                  `request ${requestId} resolves before its turn ends`,
                ).toBeLessThan(completedAt);
              }
              expect(tags("request.resolved")).toHaveLength(tags("request.opened").length);
            }),
          ),
          Effect.scoped,
          Effect.provide(TestClock.layer()),
        ),
      ));
  }
});
