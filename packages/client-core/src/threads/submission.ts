/**
 * What the composer hands the system on send: a spawn on a draft thread, one
 * input on an active one. An active thread's placement, access mode and
 * account are fixed, so its input carries the text and only the picks the user
 * actually made - a key that is absent is a value the session keeps.
 */
import type { SessionInputPayload, SessionSpawnInput } from "@hydra/contract";
import {
  effectiveConfig,
  threadConfig,
  type MessageDraft,
  type Thread,
  type ThreadPicks,
} from "./config";

export type Submission =
  | { readonly kind: "spawn"; readonly input: SessionSpawnInput }
  | {
      readonly kind: "input";
      readonly sessionId: string;
      readonly payload: SessionInputPayload;
    };

export const submission = (
  thread: Thread,
  picks: ThreadPicks,
  message: MessageDraft,
): Submission => {
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

  // Nothing unpicked is sent as an empty string: the server has its own
  // fallback for each of these and `Id` refuses one outright.
  const config = effectiveConfig(threadConfig(thread), picks);
  // A thread that works without a checkout is spelled by leaving `workspace`
  // off, and a draft that has resolved none says nothing either: neither
  // `{ kind: "none" }` nor `null` is a value the contract has a field for.
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
};
