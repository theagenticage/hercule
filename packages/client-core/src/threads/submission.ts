/**
 * Builds the request the composer sends: a spawn for a draft thread, and an
 * input for an active one. An active thread's placement, access mode and
 * account are fixed, so its input has the text and only the picks the user
 * actually made. A key that is left out keeps the session's current value.
 */
import type { SessionInputPayload, SessionSpawnInput } from "@hercule/contract";
import {
  computeEffectiveConfig,
  readThreadConfig,
  type MessageDraft,
  type Thread,
  type ThreadPicks,
} from "./config";

/** The request that starts a Draft Thread. */
interface SpawnSubmission {
  readonly kind: "spawn";
  readonly input: SessionSpawnInput;
}

/** The request that sends a message to a thread that has started. */
interface InputSubmission {
  readonly kind: "input";
  readonly sessionId: string;
  readonly payload: SessionInputPayload;
}

export type Submission = SpawnSubmission | InputSubmission;

/**
 * Returns the request that sends `message` with `picks` from `thread`: an
 * input for a thread that has started, and a spawn for a Draft Thread.
 *
 * A caller that knows which kind of thread it holds gets that kind of request
 * back, so it need not check the request's kind.
 */
export function buildSubmission(
  thread: Extract<Thread, { kind: "active" }>,
  picks: ThreadPicks,
  message: MessageDraft,
): InputSubmission;
export function buildSubmission(
  thread: Extract<Thread, { kind: "draft" }>,
  picks: ThreadPicks,
  message: MessageDraft,
): SpawnSubmission;
export function buildSubmission(
  thread: Thread,
  picks: ThreadPicks,
  message: MessageDraft,
): Submission;
export function buildSubmission(
  thread: Thread,
  picks: ThreadPicks,
  message: MessageDraft,
): Submission {
  if (thread.kind === "active") {
    const { model, options } = picks;
    return {
      kind: "input",
      sessionId: thread.session.id,
      payload: {
        text: message.text,
        ...(model === undefined || model === null ? {} : { model }),
        ...(options === undefined ? {} : { options }),
      },
    };
  }

  // A field the user did not pick is left out, never sent as an empty string:
  // the controller has its own default for each one, and the `Id` schema
  // rejects an empty string.
  const config = computeEffectiveConfig(readThreadConfig(thread), picks);
  // Leave `workspace` out both for a thread that works without a checkout and
  // for a draft with no workspace chosen yet: the contract accepts neither
  // `{ kind: "none" }` nor `null` for the field.
  const workspace = config.workspace ?? null;
  return {
    kind: "spawn",
    input: {
      prompt: message.text,
      ...(config.instanceId === null ? {} : { instanceId: config.instanceId }),
      ...(config.model === null ? {} : { model: config.model }),
      options: config.options,
      accessMode: config.accessMode,
      ...(config.runnerId === null ? {} : { runnerId: config.runnerId }),
      ...(config.profileId === null ? {} : { permissionProfileId: config.profileId }),
      ...(config.projectId === null || config.projectId === undefined
        ? {}
        : { projectId: config.projectId }),
      ...(workspace === null || workspace.kind === "none" ? {} : { workspace }),
    },
  };
}
