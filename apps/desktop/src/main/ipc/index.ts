/**
 * Main's side of the IPC contract: one handler per renderer-to-main channel,
 * registered with Electron once at boot.
 */
import { ipcMain } from "electron";
import type { Effect, ManagedRuntime } from "effect";
import type { RendererToMainIpcChannelName } from "../../ipc/bridge";
import { RENDERER_TO_MAIN_IPC_CHANNELS } from "../../ipc/contract";
import { AppSettings } from "../app-settings";
import { answerIpcMessage } from "./message";

type RendererToMainIpcChannels = typeof RENDERER_TO_MAIN_IPC_CHANNELS;

/**
 * The services the IPC handlers use. A handler that needs another service
 * adds it to this union, and main's runtime must then provide it.
 */
export type IpcHandlerServices = AppSettings;

/**
 * What main does for each channel, given the decoded request. The table is
 * typed by the contract, so a channel with no handler is a type error.
 */
const IPC_HANDLERS: {
  readonly [Name in RendererToMainIpcChannelName]: (
    request: RendererToMainIpcChannels[Name]["request"]["Type"],
  ) => Effect.Effect<
    RendererToMainIpcChannels[Name]["response"]["Type"],
    never,
    IpcHandlerServices
  >;
} = {
  "controllerUrl.read": () => AppSettings.use((settings) => settings.readControllerUrl),
};

/**
 * Registers the handler of every renderer-to-main channel with Electron. Each
 * message runs on `runtime`: main checks its sender, decodes its request, runs
 * the channel's handler and encodes the response (see `answerIpcMessage`).
 *
 * Call it once, before the window loads its page.
 */
export const registerIpcHandlers = (
  runtime: ManagedRuntime.ManagedRuntime<IpcHandlerServices, never>,
): void => {
  const registerIpcHandler = <Name extends RendererToMainIpcChannelName>(name: Name) =>
    ipcMain.handle(name, (event, ...args) =>
      runtime.runPromise(
        answerIpcMessage(name, RENDERER_TO_MAIN_IPC_CHANNELS[name], IPC_HANDLERS[name], {
          senderFrame: event.senderFrame,
          mainFrame: event.sender.mainFrame,
          args,
        }),
      ),
    );
  for (const name of Object.keys(
    RENDERER_TO_MAIN_IPC_CHANNELS,
  ) as Array<RendererToMainIpcChannelName>) {
    registerIpcHandler(name);
  }
};
