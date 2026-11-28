/**
 * Events an adapter reports itself about input it has just delivered, rather
 * than events it reads from the harness's output. Also the helper that makes an
 * id valid for the protocol.
 */
import type { AttachmentReference, HarnessEvent, SubagentId } from "@hercule/protocol";
import { now } from "../report";
import { truncateFact, truncateMessage } from "./text";

/**
 * Returns `given` truncated to the length the protocol allows, or a new random
 * id when `given` is empty. A longer id would make the frame impossible to
 * decode, and the whole event would be lost. When the harness gives no id, a
 * random one is used so the event is still reported.
 */
export const ensureId = (given: string): string =>
  given === "" ? crypto.randomUUID() : truncateFact(given);

/**
 * Returns the events of an input the adapter has just delivered: the user's
 * message as the pair `item.started` and `item.completed`, then, when a skill
 * was skipped, the `runtime.warning` that tells the user. An adapter emits all
 * of them in one go, so no output of the harness lands between the message and
 * its warning. Every adapter builds these itself rather than from the
 * harness's echo of the message, because only the adapter knows whether the
 * input steered a running turn. The echo does not identify which input it
 * belongs to, and it holds the prompt the harness got, with the sender header
 * and the image lines. So the `user_message` is always built from the input,
 * never from the harness's echo.
 *
 * The images of the input go in `detail.attachments` as references: id, name,
 * type and size. Never their bytes, and never the runner's path, so the
 * stream stays small and the transcript reads the same on every client.
 *
 * The Skill References the runner translated for the harness go in
 * `detail.skills` as their names (`review`, `webshop:release`), each once, in
 * order of first appearance. The key is absent when there are none.
 *
 * When another session's agent sent the input, that session's id goes in
 * `detail.senderSessionId`. The key is absent otherwise.
 *
 * The warning lists every skipped skill, so an input gets at most one. It
 * belongs to `turnId`, the turn the input opened or steered. An adapter skips
 * a skill when its `SKILL.md` is missing, is not a regular file, or leads
 * outside the skill's folder.
 * The message was still sent, so the warning says it went without the skills.
 */
export const buildUserMessage = (input: {
  readonly sessionId: string;
  /** The subagent the message is for, or undefined for the session's own agent. */
  readonly subagentId?: SubagentId | undefined;
  readonly turnId: string;
  readonly text: string;
  readonly steered: boolean;
  /** The images of the input, in order. */
  readonly attachments?: ReadonlyArray<AttachmentReference> | undefined;
  /** The Skill References the adapter translated for the harness, in text order. */
  readonly skillReferences?: ReadonlyArray<{ readonly referenceName: string }> | undefined;
  /**
   * The skills the adapter could not give the harness. `names` are the
   * references as typed, such as `review` or `webshop:release`. No warning is
   * built when `names` is empty or this is absent.
   */
  readonly skippedSkills?:
    | {
        /** The harness's display name, such as `Codex`. */
        readonly harnessName: string;
        readonly names: ReadonlyArray<string>;
      }
    | undefined;
  /** The session whose agent sent the input, or undefined when no other agent did. */
  readonly senderSessionId?: string | undefined;
  /** The harness's own ids for the item, if the adapter has any. */
  readonly harnessRefs?: Readonly<Record<string, string>>;
}): ReadonlyArray<HarnessEvent> => {
  const item = {
    sessionId: input.sessionId,
    at: now(),
    ...(input.subagentId === undefined ? {} : { subagentId: input.subagentId }),
    turnId: input.turnId,
    itemId: crypto.randomUUID(),
    kind: "user_message",
    detail: {
      text: input.text,
      ...(input.steered ? { steered: true } : {}),
      ...(input.attachments === undefined || input.attachments.length === 0
        ? {}
        : {
            attachments: input.attachments.map(({ id, name, mimeType, sizeBytes }) => ({
              id,
              name,
              mimeType,
              sizeBytes,
            })),
          }),
      ...(input.skillReferences === undefined || input.skillReferences.length === 0
        ? {}
        : { skills: [...new Set(input.skillReferences.map((skill) => skill.referenceName))] }),
      ...(input.senderSessionId === undefined ? {} : { senderSessionId: input.senderSessionId }),
    },
    ...(input.harnessRefs === undefined ? {} : { harnessRefs: input.harnessRefs }),
  } as const;
  const events: Array<HarnessEvent> = [
    { _tag: "item.started", eventId: crypto.randomUUID(), ...item },
    { _tag: "item.completed", eventId: crypto.randomUUID(), ...item, status: "completed" },
  ];
  const skipped = input.skippedSkills;
  if (skipped !== undefined && skipped.names.length > 0) {
    const plural = skipped.names.length > 1;
    const names = skipped.names.map((name) => `$${name}`).join(", ");
    events.push({
      _tag: "runtime.warning",
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      at: now(),
      turnId: input.turnId,
      message: truncateMessage(
        `Hercule could not give ${skipped.harnessName} the ${plural ? "skills" : "skill"} ${names}: ${plural ? "their SKILL.md files are missing, are not regular files, or lead outside the skills' folders" : "its SKILL.md is missing, is not a regular file, or leads outside the skill's folder"}. The message was sent without ${plural ? "them" : "it"}. Check the ${plural ? "skills' folders" : "skill's folder"}, then send the message again.`,
      ),
    });
  }
  return events;
};
