/**
 * Plays every recording of a real `agy` session (`@hercule/acp/testing`)
 * through the normalizer the way the session does, and checks invariants over
 * each whole event stream. The focused tests in `normalize.test.ts` check what
 * particular events look like; these checks catch a stream that is broken as a
 * whole, such as an item that never completes or two turns open at once.
 */
import type { SessionUpdate, SessionUpdateNotification } from "@hercule/acp";
import { RECORDING_NAMES, readRecording, type RecordedMessage } from "@hercule/acp/testing";
import type { HarnessEvent } from "@hercule/protocol";
import { describe, expect, it } from "vitest";
import { expectEventStreamToHoldTogether } from "./event-stream.testing";
import { buildPlanFilePaths } from "./harness-home";
import {
  addPromptUsage,
  buildNormalizerState,
  buildProcessEndEvents,
  closeTurn,
  holdTurn,
  normalizeUpdate,
  openTurn,
} from "./normalize";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const HOME = "/tmp/agy-spike/acctC";
const KNOWN_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "current_mode_update",
  "config_option_update",
]);

/** The turn id of the recorded prompt with this request id. Synthetic turns get other ids. */
const promptTurnId = (requestId: string | number): string => `prompt-${String(requestId)}`;

/** Maps the params of a `session/update` as the connection does: a kind the client does not use becomes `other`. */
const buildNotification = (params: {
  sessionId: string;
  update: { sessionUpdate: string };
}): SessionUpdateNotification => ({
  nativeSessionId: params.sessionId,
  update: KNOWN_UPDATES.has(params.update.sessionUpdate)
    ? (params.update as unknown as SessionUpdate)
    : { sessionUpdate: "other", name: params.update.sessionUpdate },
  raw: params,
});

/** Splits a recording at each `initialize` the client sent: one part per `agy` process. */
const splitProcesses = (messages: ReadonlyArray<RecordedMessage>): RecordedMessage[][] => {
  const parts: RecordedMessage[][] = [];
  for (const entry of messages) {
    if (entry.direction === "out" && entry.message.method === "initialize") parts.push([]);
    (parts.at(-1) ?? parts[parts.push([]) - 1]!).push(entry);
  }
  return parts;
};

interface PlayedProcess {
  readonly events: HarnessEvent[];
  /** The events that arrived while a recorded prompt was open, to tell synthetic turns apart. */
  readonly openedWhilePromptOpen: string[];
}

/** Plays one `agy` process: a turn per recorded prompt, closed at its reply, then the process end. */
const playProcess = (messages: ReadonlyArray<RecordedMessage>): PlayedProcess => {
  const nativeSessionId = messages
    .map(
      ({ message }) =>
        (message.result as { sessionId?: string } | undefined)?.sessionId ??
        (message.params as { sessionId?: string } | undefined)?.sessionId,
    )
    .find((id) => id !== undefined)!;
  const state = buildNormalizerState({
    sessionId: SESSION,
    nativeSessionId,
    planFilePaths: buildPlanFilePaths(HOME, nativeSessionId),
  });
  const events: HarnessEvent[] = [];
  const openedWhilePromptOpen: string[] = [];
  const openPrompts = new Set<string | number>();
  const push = (produced: HarnessEvent[]) => {
    for (const event of produced) {
      if (
        event._tag === "turn.started" &&
        openPrompts.size > 0 &&
        !event.turnId.startsWith("prompt-")
      ) {
        openedWhilePromptOpen.push(event.turnId);
      }
    }
    events.push(...produced);
  };
  for (const { direction, message } of messages) {
    if (direction === "out" && message.method === "session/prompt") {
      holdTurn(state);
      openPrompts.add(message.id!);
      push(openTurn(state, promptTurnId(message.id!)));
    } else if (direction === "in" && message.method === "session/update") {
      push(
        normalizeUpdate(
          state,
          buildNotification(message.params as Parameters<typeof buildNotification>[0]),
        ),
      );
    } else if (direction === "in" && message.id !== undefined && openPrompts.has(message.id)) {
      openPrompts.delete(message.id);
      const reply = message.result as { stopReason?: string; usage?: never } | undefined;
      push([
        ...addPromptUsage(state, reply?.usage),
        ...closeTurn(state, {
          state: reply?.stopReason === "cancelled" ? "interrupted" : "completed",
          turnId: promptTurnId(message.id),
        }),
      ]);
    }
  }
  // A process that ended with a prompt unanswered: the session closes its turn as interrupted.
  push(closeTurn(state, { state: "interrupted" }));
  push(buildProcessEndEvents(state));
  return { events, openedWhilePromptOpen };
};

/** Recordings with no session to normalize, with the reason. */
const RECORDINGS_WITHOUT_A_SESSION: ReadonlyArray<string> = [
  // Ends at the refused `authenticate`, so no `session/new` follows.
  "gemini-dir-default",
];

describe("every recording through the normalizer", () => {
  for (const name of RECORDING_NAMES.filter((n) => !RECORDINGS_WITHOUT_A_SESSION.includes(n))) {
    it(`${name}: the event stream holds together`, () => {
      const parts = splitProcesses(readRecording(name));
      for (const part of parts) {
        const { events, openedWhilePromptOpen } = playProcess(part);

        expectEventStreamToHoldTogether(events);

        expect(openedWhilePromptOpen, "no synthetic turn while a prompt is open").toEqual([]);
      }
    });
  }
});
