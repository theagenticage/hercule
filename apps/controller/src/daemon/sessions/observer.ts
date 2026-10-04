/**
 * The sessions domain's `SessionObserver`, as boot provides it to the session
 * service: every domain that watches sessions, told in turn.
 *
 * - The assistants domain writes an assistant's replies and notices into its
 *   conversation.
 * - The runs domain fails an agent step whose turn no runner will report.
 *
 * The sessions domain cannot import either domain, and the runs domain
 * already imports the sessions domain, so the observers are joined here.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeAssistantSessionObserver } from "../../assistants";
import type { ConversationMessages } from "../../conversations";
import { makeRunSessionObserver, type StepSessionFailures } from "../../runs";
import { combineSessionObservers, SessionObserver } from "../../sessions";

export const SessionObserverLayer: Layer.Layer<
  SessionObserver,
  never,
  SqlClient.SqlClient | ConversationMessages | StepSessionFailures
> = Layer.effect(SessionObserver)(
  Effect.gen(function* () {
    return combineSessionObservers([
      yield* makeAssistantSessionObserver,
      yield* makeRunSessionObserver,
    ]);
  }),
);
