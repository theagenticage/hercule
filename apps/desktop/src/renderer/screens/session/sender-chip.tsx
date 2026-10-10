/**
 * The chip that names another session's agent where it sent a message into
 * a thread: above its bubble in the transcript, and in place of the clock in
 * its queued row. The rules are the Bureau book's `.mention`
 * (desktop/assistant.html): the agent's face, then its name in its hue.
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { SenderReading } from "@hercule/client-core";
import { buildAssistantLook, buildLook, Face, type Look } from "../../faces";
import "./sender-chip.css";

/** The size of the face in a sender chip, in CSS pixels. */
const SENDER_FACE_SIZE = 18;

/**
 * Returns the look of `sender`'s face: an assistant's look for an assistant,
 * a thread's look for any other agent. The same sender always gets the same
 * frozen object, so a memoized component that takes it is not drawn again.
 */
export const buildSenderLook = (sender: SenderReading): Look =>
  sender.faceKind === "assistant"
    ? buildAssistantLook(sender.faceSeed)
    : buildLook(sender.faceSeed);

/**
 * Renders `sender` as a chip: its face, idle and still, then its name. The
 * chip is a link to the sender's thread or assistant when it has one, with
 * the focus ring every link has, and plain text when it has none. Its hue
 * comes from the nearest element that sets `--hue`, which the caller sets
 * from `look` so the chip and what it labels share one colour.
 *
 * The face never moves: the sender's state is not what the chip shows, and
 * only the running turn's face moves in a thread.
 */
export function SenderChip({
  sender,
  look,
}: {
  readonly sender: SenderReading;
  readonly look: Look;
}): JSX.Element {
  const content = (
    <>
      <Face look={look} pose="idle" size={SENDER_FACE_SIZE} />
      <span className="sender-chip-name">{sender.name}</span>
    </>
  );
  const { link } = sender;
  switch (link.kind) {
    case "thread":
      return (
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: link.sessionId }}
          className="sender-chip"
          title={sender.name}
        >
          {content}
        </Link>
      );
    case "assistant":
      return (
        <Link
          to="/assistants/$assistantId"
          params={{ assistantId: link.assistantId }}
          className="sender-chip"
          title={sender.name}
        >
          {content}
        </Link>
      );
    case "none":
      return (
        <span className="sender-chip" title={sender.name}>
          {content}
        </span>
      );
  }
}
