/**
 * What the composer hands the system on send: a spawn on a draft thread, one
 * input on an active one. An active thread's placement, access mode and
 * account are fixed, so its input carries the text and only the picks the user
 * actually made - a key that is absent is a value the session keeps.
 */
import type { SessionInputPayload, SessionSpawnInput } from "@hydra/contract";
import { effectiveConfig, type MessageDraft, type Thread, type ThreadPicks } from "./config";

export const submission = (
  thread: Thread,
  picks: ThreadPicks,
  message: MessageDraft,
): SessionSpawnInput | SessionInputPayload => {
  if (thread.kind === "active") {
    const { model, options } = picks;
    return {
      text: message.text,
      ...(model === undefined || model === null ? {} : { model }),
      ...(options === undefined ? {} : { options }),
    };
  }

  // Nothing unpicked is sent as an empty string: the server has its own
  // fallback for each of these and `Id` refuses one outright.
  const config = effectiveConfig(thread.config, picks);
  return {
    prompt: message.text,
    ...(config.instanceId === null ? {} : { instanceId: config.instanceId }),
    ...(config.model === null ? {} : { model: config.model }),
    options: config.options,
    accessMode: config.accessMode,
    ...(config.runnerId === null ? {} : { runnerId: config.runnerId }),
    ...(config.profileId === null ? {} : { permissionProfileId: config.profileId }),
    workspaceId: null,
  };
};
