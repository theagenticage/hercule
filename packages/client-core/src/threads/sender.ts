/**
 * How the sender of a message is shown when another session's agent sent it
 * into a thread: a name, a face, and what the name links to.
 *
 * A sender is known only by its session id. What the screen shows depends on
 * what the app could read about that session, and both apps must agree, so
 * the rule lives here with a test rather than inside a component.
 */
import type { Assistant, Input, Session } from "@hercule/contract";
import { findAnsweredAssistantId } from "../assistants/conversation";
import { toIdTail } from "../id-tail";

/** What a sender's name links to: nothing, the sender's thread, or its assistant's page. */
export type SenderLink =
  | { readonly kind: "none" }
  | { readonly kind: "thread"; readonly sessionId: string }
  | { readonly kind: "assistant"; readonly assistantId: string };

export interface SenderReading {
  /** What to print. Never empty. */
  readonly name: string;
  /**
   * Which kind of face to draw: an assistant's face, seeded by the assistant
   * id, or a thread's face, seeded by the session id. The desktop app draws
   * the two kinds differently, so an assistant's face matches it everywhere.
   */
  readonly faceKind: "assistant" | "thread";
  /** The id the face is drawn from: the assistant id or the session id, as `faceKind` says. */
  readonly faceSeed: string;
  readonly link: SenderLink;
}

/**
 * Returns how to show the agent of session `senderSessionId` as the sender of
 * a message. `session` is that session as the app read it, or `undefined`
 * when the read failed: the session was deleted, or the reader may not read
 * it. `assistants` is the assistant list the app holds.
 *
 * - A session that answers an assistant's conversation is shown as that
 *   assistant: its name, its face, and a link to its page.
 * - Any other readable session is shown by its title, with a thread's face
 *   and a link to its thread. A session with an empty title is named by its
 *   id, as "session 7c82ebeb", so the name is never blank.
 * - A session that could not be read is "Another agent", with a thread's face
 *   from its id and no link.
 *
 * A session that answers a conversation whose assistant is not in
 * `assistants` (deleted, or the list not read yet) is shown as any other
 * readable session. Its title and its thread are still real, so that reading
 * is true, where naming the assistant is not possible.
 */
export const describeSender = (
  senderSessionId: string,
  session: Session | undefined,
  assistants: readonly Assistant[],
): SenderReading => {
  if (session === undefined) {
    return {
      name: "Another agent",
      faceKind: "thread",
      faceSeed: senderSessionId,
      link: { kind: "none" },
    };
  }
  const assistantId = findAnsweredAssistantId(session);
  const assistant = assistants.find((candidate) => candidate.id === assistantId);
  if (assistant !== undefined) {
    return {
      name: assistant.name,
      faceKind: "assistant",
      faceSeed: assistant.id,
      link: { kind: "assistant", assistantId: assistant.id },
    };
  }
  return {
    name: session.title === "" ? `session ${toIdTail(session.id)}` : session.title,
    faceKind: "thread",
    faceSeed: session.id,
    link: { kind: "thread", sessionId: session.id },
  };
};

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
  if (input.source !== "user" || !input.actor.startsWith("session:")) return undefined;
  const senderSessionId = input.actor.slice("session:".length);
  return senderSessionId === "" || senderSessionId === input.sessionId
    ? undefined
    : senderSessionId;
};
