/**
 * Exposes the bridge to the renderer as `window.bridge`: one function per
 * channel of the IPC contract, and nothing else.
 *
 * The preload imports only types from the contract, so it loads no Effect and
 * stays one small file. It checks nothing itself: main checks the sender and
 * decodes the request of every message, because the renderer is untrusted.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  Bridge,
  EncodedIpcRequest,
  EncodedIpcResponse,
  RendererToMainIpcChannelName,
} from "../ipc/bridge";
import type { IpcReply } from "../ipc/contract";

/**
 * Sends one message to main on `channel` and returns main's response. Fails
 * with main's reason when main refuses the message.
 */
const invokeChannel = async <Name extends RendererToMainIpcChannelName>(
  channel: Name,
  ...request: EncodedIpcRequest<Name> extends undefined ? [] : [EncodedIpcRequest<Name>]
): Promise<EncodedIpcResponse<Name>> => {
  const reply = (await ipcRenderer.invoke(channel, ...request)) as IpcReply<
    EncodedIpcResponse<Name>
  >;
  if ("refusal" in reply) throw new Error(reply.refusal);
  return reply.response;
};

const bridge: Bridge = {
  controllerUrl: {
    read: () => invokeChannel("controllerUrl.read"),
  },
};

contextBridge.exposeInMainWorld("bridge", bridge);
