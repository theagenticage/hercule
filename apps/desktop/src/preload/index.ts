/**
 * Exposes the bridge to the renderer as `window.bridge`: one function per
 * channel of the IPC contract, and nothing else.
 *
 * The preload imports only types from the contract, so it loads no Effect and
 * stays one small file. It checks nothing itself: main checks the sender and
 * decodes the request of every message, because the renderer is untrusted,
 * and main has encoded every payload it sends against the contract.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  Bridge,
  EncodedIpcPayload,
  EncodedIpcRequest,
  EncodedIpcResponse,
  MainToRendererIpcChannelName,
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

/**
 * Calls `listener` with the payload of each message main sends on `channel`,
 * and returns a function that removes the listener. The listener never sees
 * Electron's event object, whose `sender` would let the page send anything.
 */
const subscribeToChannel = <Name extends MainToRendererIpcChannelName>(
  channel: Name,
  listener: (payload: EncodedIpcPayload<Name>) => void,
): (() => void) => {
  const forwardPayload = (_event: IpcRendererEvent, payload: EncodedIpcPayload<Name>) => {
    listener(payload);
  };
  ipcRenderer.on(channel, forwardPayload);
  return () => {
    ipcRenderer.removeListener(channel, forwardPayload);
  };
};

const bridge: Bridge = {
  controllerUrl: {
    read: () => invokeChannel("controllerUrl.read"),
    save: (url) => invokeChannel("controllerUrl.save", url),
  },
  token: {
    read: () => invokeChannel("token.read"),
    write: (token) => invokeChannel("token.write", token),
  },
  firstScreen: {
    report: () => invokeChannel("firstScreen.report"),
  },
  menu: {
    onCommand: (listener) => subscribeToChannel("menu.command", listener),
  },
};

contextBridge.exposeInMainWorld("bridge", bridge);
