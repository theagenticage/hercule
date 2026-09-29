/**
 * How main prepares a message on a main-to-renderer channel: it encodes the
 * payload against the IPC contract, so the renderer receives only what the
 * contract allows.
 *
 * Nothing here imports Electron, so the encoding runs in unit tests.
 */
import { Effect, Schema } from "effect";
import type { EncodedIpcPayload, MainToRendererIpcChannelName } from "../../ipc/bridge";
import { MAIN_TO_RENDERER_IPC_CHANNELS } from "../../ipc/contract";

type MainToRendererIpcChannels = typeof MAIN_TO_RENDERER_IPC_CHANNELS;

/**
 * Encodes `payload` against the schema of the main-to-renderer channel
 * `name`, and returns the encoded payload to send with `webContents.send`.
 *
 * A payload that does not encode is a bug in main, so it is a defect rather
 * than an error the caller handles.
 */
export const encodeIpcPayload = <Name extends MainToRendererIpcChannelName>(
  name: Name,
  payload: MainToRendererIpcChannels[Name]["payload"]["Type"],
): Effect.Effect<
  EncodedIpcPayload<Name>,
  never,
  MainToRendererIpcChannels[Name]["payload"]["EncodingServices"]
> => Effect.orDie(Schema.encodeEffect(MAIN_TO_RENDERER_IPC_CHANNELS[name].payload)(payload));
