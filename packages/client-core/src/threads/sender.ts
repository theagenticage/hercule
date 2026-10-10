/**
 * How the sender of a message is shown when another session's agent sent it
 * into a thread: a name, a face, and what the name links to.
 *
 * A sender is known only by its session id. What the screen shows depends on
 * what the app could read about that session, and both apps must agree, so
 * the rule lives here with a test rather than inside a component.
 */
import type { Assistant, Input, Session, TranscriptRow } from "@hercule/contract";
import { describeActor, type ActorReading, type ActorTarget } from "../actor-display";
import { findAnsweredAssistantId } from "../assistants/conversation";
import type { HerculeClient } from "../client";
import { ApiError } from "../errors";
import { toIdTail } from "../id-tail";
import { readUserSender } from "./turns";

/**
 * How to show the agent that sent a message. It is an `ActorReading`, so a
 * screen can show it wherever it shows who made a change.
 */
export interface SenderReading extends ActorReading {
  /**
   * The sender's name as it reads inside a sentence: "Sent by Ada", "Message
   * from another agent". Never empty.
   */
  readonly label: string;
  /**
   * The sender's name as it reads on its own, as in a chip: "Ada", "Another
   * agent". It differs from `label` only for a sender that could not be read.
   */
  readonly name: string;
  /**
   * The face to draw: an assistant's face, seeded by the assistant id, or a
   * thread's face, seeded by the session id. The desktop app draws the two
   * kinds differently, so an assistant's face matches it everywhere.
   */
  readonly face: { readonly kind: "assistant" | "thread"; readonly seed: string };
  /** What the name links to. A sender is a session, so it never links to a run. */
  readonly link: Exclude<ActorTarget, { readonly kind: "run" }>;
}

/**
 * Returns how to show the agent of session `senderSessionId` as the sender of
 * a message. `session` is that session as the app read it, or `null` when
 * `readSenderSession` found it cannot be read: the session was deleted, or
 * the reader may not read it. `assistants` is the assistant list the app
 * holds.
 *
 * - A session that answers an assistant's conversation is shown as that
 *   assistant: its name, its face, and a link to its page.
 * - Any other readable session is shown by its title, with a thread's face
 *   and a link to its thread. A session with an empty title is named by its
 *   id, as "session 7c82ebeb", so the name is never blank.
 * - A session that could not be read is "another agent" inside a sentence
 *   and "Another agent" on its own, with a thread's face from its id and no
 *   link.
 *
 * A session that answers a conversation whose assistant is not in
 * `assistants` (deleted, or the list not read yet) is shown as any other
 * readable session. Its title and its thread are still real, so that reading
 * is true, where naming the assistant is not possible.
 */
export const describeSender = (
  senderSessionId: string,
  session: Session | null,
  assistants: readonly Assistant[],
): SenderReading => {
  if (session === null) {
    return {
      label: "another agent",
      name: "Another agent",
      face: { kind: "thread", seed: senderSessionId },
      link: { kind: "none" },
    };
  }
  const assistantId = findAnsweredAssistantId(session);
  const assistant = assistants.find((candidate) => candidate.id === assistantId);
  if (assistant !== undefined) {
    return {
      label: assistant.name,
      name: assistant.name,
      face: { kind: "assistant", seed: assistant.id },
      link: { kind: "assistant", assistantId: assistant.id },
    };
  }
  const name = session.title === "" ? `session ${toIdTail(session.id)}` : session.title;
  return {
    label: name,
    name,
    face: { kind: "thread", seed: session.id },
    link: { kind: "session", sessionId: session.id },
  };
};

/**
 * Reads the session of the agent that sent a message, for `describeSender`.
 * Returns `null` when the controller answers that the session cannot be
 * read: 404 because it was deleted, or 403 because the user may not read it.
 * Neither is a failure, because the message still shows, from "another
 * agent". Fails with the client's error for anything else, such as a
 * controller that did not answer.
 */
export const readSenderSession = (client: HerculeClient, id: string): Promise<Session | null> =>
  client.session.read({ params: { id } }).catch((error: unknown) => {
    if (error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden")) {
      return null;
    }
    throw error;
  });

/**
 * Returns the id of the session whose agent queued `input`, or `undefined`
 * when the session's owner, a run, or the session itself queued it, or when
 * it is not a message at all (a subscription delivery, for example). This is
 * the controller's rule for the sender a delivered message carries, so a
 * queued row and the message it becomes name the same sender.
 */
export const readInputSender = (
  input: Pick<Input, "sessionId" | "source" | "actor">,
): string | undefined => {
  if (input.source !== "user") return undefined;
  const { link } = describeActor(input.actor);
  return link.kind === "session" && link.sessionId !== input.sessionId ? link.sessionId : undefined;
};

/**
 * Returns the id of every session whose agent sent a message into a thread,
 * once each, in the order they first appear: first the senders of the
 * messages in the transcript `rows`, then those of the queued `inputs`. A
 * thread's loader reads each of these senders before the first paint.
 *
 * It looks at each row once and builds nothing else, so a loader does not
 * group the whole transcript into turns just to find who sent what.
 */
export const collectSenderSessionIds = (
  rows: readonly TranscriptRow[],
  inputs: readonly Pick<Input, "sessionId" | "source" | "actor">[],
): readonly string[] => {
  const senderSessionIds = new Set<string>();
  for (const { event } of rows) {
    if (event._tag !== "item.started" || event.kind !== "user_message") continue;
    const senderSessionId = readUserSender(event.detail);
    if (senderSessionId !== undefined) senderSessionIds.add(senderSessionId);
  }
  for (const input of inputs) {
    const senderSessionId = readInputSender(input);
    if (senderSessionId !== undefined) senderSessionIds.add(senderSessionId);
  }
  return [...senderSessionIds];
};
