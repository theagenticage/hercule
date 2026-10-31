/**
 * Builds the request the composer sends: a spawn for a draft thread, and an
 * input for an active one. An active thread's placement, access mode and
 * account are fixed, so its input has the text and only what the resolved
 * thread changes (`outgoing`). A key that is left out keeps the session's
 * current value. Either request carries the ids of the draft's uploaded
 * images, and leaves `attachments` out when there are none.
 */
import type { SessionInputPayload, SessionSpawnInput } from "@hercule/contract";
import { listUploadedAttachmentIds } from "../attachments/shelf";
import type { MessageDraft } from "./config";
import type { ResolvedActive, ResolvedDraft, ResolvedThread } from "./resolve-thread";

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
 * Returns the request that sends `message` from the resolved thread: an
 * input for a thread that has started, and a spawn for a Draft Thread.
 *
 * A caller that knows which kind of thread it holds gets that kind of request
 * back, so it need not check the request's kind.
 */
export function buildSubmission(resolved: ResolvedActive, message: MessageDraft): InputSubmission;
export function buildSubmission(resolved: ResolvedDraft, message: MessageDraft): SpawnSubmission;
export function buildSubmission(resolved: ResolvedThread, message: MessageDraft): Submission;
export function buildSubmission(resolved: ResolvedThread, message: MessageDraft): Submission {
  const attachmentIds = listUploadedAttachmentIds(message.attachments);
  const attachments = attachmentIds.length === 0 ? {} : { attachments: attachmentIds };
  if (resolved.kind === "active") {
    return {
      kind: "input",
      sessionId: resolved.sessionId,
      payload: { text: message.text, ...attachments, ...resolved.outgoing },
    };
  }

  // A field the user did not pick is left out, never sent as an empty string:
  // the controller has its own default for each one, and the `Id` schema
  // rejects an empty string.
  const { config } = resolved;
  const { workspace } = config;
  return {
    kind: "spawn",
    input: {
      prompt: message.text,
      ...attachments,
      ...(config.providerAccountId === null ? {} : { providerAccountId: config.providerAccountId }),
      ...(config.harnessId === null ? {} : { harnessId: config.harnessId }),
      ...(config.model === null ? {} : { model: config.model }),
      options: config.options,
      accessMode: config.accessMode,
      ...(config.runnerId === null ? {} : { runnerId: config.runnerId }),
      ...(config.profileId === null ? {} : { permissionProfileId: config.profileId }),
      ...(config.projectId === null || config.projectId === undefined
        ? {}
        : { projectId: config.projectId }),
      // A thread that works without a checkout leaves `workspace` out: the
      // contract does not accept `{ kind: "none" }` for the field. A main
      // workspace is sent by its repo alone, because it is the one shared
      // branch.
      ...(workspace.kind === "none"
        ? {}
        : {
            workspace:
              workspace.kind === "primary"
                ? { kind: "primary", resourceId: workspace.resourceId }
                : workspace,
          }),
    },
  };
}
