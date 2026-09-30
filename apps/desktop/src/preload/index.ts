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
import type { Bridge } from "../ipc/bridge";
import type {
  EncodedIpcPayload,
  EncodedIpcRequest,
  EncodedIpcResponse,
  IpcReply,
  MainToRendererIpcChannelName,
  RendererToMainIpcChannelName,
} from "../ipc/contract";

/**
 * Sends one message to main on the channel `name` and returns main's
 * response. Fails with main's reason when main refuses the message.
 */
const invokeChannel = async <Name extends RendererToMainIpcChannelName>(
  name: Name,
  ...request: EncodedIpcRequest<Name> extends undefined ? [] : [EncodedIpcRequest<Name>]
): Promise<EncodedIpcResponse<Name>> => {
  const reply = (await ipcRenderer.invoke(name, ...request)) as IpcReply<EncodedIpcResponse<Name>>;
  if ("refusal" in reply) throw new Error(reply.refusal);
  return reply.response;
};

/**
 * Calls `listener` with the payload of each message main sends on the
 * channel `name`, and returns a function that removes the listener. The
 * listener never sees Electron's event object, whose `sender` would let the
 * page send anything.
 */
const subscribeToChannel = <Name extends MainToRendererIpcChannelName>(
  name: Name,
  listener: (payload: EncodedIpcPayload<Name>) => void,
): (() => void) => {
  const forwardPayload = (_event: IpcRendererEvent, payload: EncodedIpcPayload<Name>) => {
    listener(payload);
  };
  ipcRenderer.on(name, forwardPayload);
  return () => {
    ipcRenderer.removeListener(name, forwardPayload);
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
  runnerIdentity: {
    read: (request) => invokeChannel("runnerIdentity.read", request),
  },
  firstScreen: {
    report: () => invokeChannel("firstScreen.report"),
  },
  goMenu: {
    set: (threads) => invokeChannel("goMenu.set", threads),
  },
  waitingThreads: {
    set: (threads) => invokeChannel("waitingThreads.set", threads),
  },
  menu: {
    onCommand: (listener) => subscribeToChannel("menu.command", listener),
  },
  thread: {
    onOpen: (listener) => subscribeToChannel("thread.open", listener),
  },
};

contextBridge.exposeInMainWorld("bridge", bridge);
