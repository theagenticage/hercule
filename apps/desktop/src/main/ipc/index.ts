/**
 * Main's side of the IPC contract: one handler per renderer-to-main channel,
 * registered with Electron once at boot.
 */
import { userInfo } from "node:os";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { Effect, Exit, type ManagedRuntime } from "effect";
import {
  type IpcRequest,
  type IpcResponse,
  RENDERER_TO_MAIN_IPC_CHANNELS,
  type RendererToMainIpcChannel,
  type RendererToMainIpcChannelName,
} from "../../ipc/contract";
import { AppSettings, type NoControllerSaved } from "../app-settings";
import { ControllerConnection } from "../controller-connection";
import { ThisMac } from "../this-mac";
import type { ControllerAlreadySaved, NoLogsFolderSeen } from "../local-controller";
import { MainWindow } from "../main-window";
import { MainMenu } from "../menu";
import { RunnerIdentity } from "../runner-identity";
import { openInBrowser } from "../security";
import { StoredToken } from "../stored-token";
import { WaitingNotifications } from "../waiting-notifications";
import { answerIpcMessage } from "./message";

/**
 * The services the IPC handlers use. A handler that needs another service
 * adds it to this union, and main's runtime must then provide it.
 */
type IpcHandlerServices =
  | AppSettings
  | ControllerConnection
  | MainMenu
  | MainWindow
  | RunnerIdentity
  | StoredToken
  | ThisMac
  | WaitingNotifications;

/**
 * The errors a handler fails with when the request makes no sense in main's
 * current state. Main refuses the message, and the error's message is the
 * reason. An outcome the user can cause is part of the response instead.
 */
type IpcHandlerError = NoControllerSaved | ControllerAlreadySaved | NoLogsFolderSeen;

/**
 * What main does for each channel, given the decoded request. The table is
 * typed by the contract, so a channel with no handler is a type error.
 */
const IPC_HANDLERS: {
  readonly [Name in RendererToMainIpcChannelName]: (
    request: IpcRequest<Name>,
  ) => Effect.Effect<IpcResponse<Name>, IpcHandlerError, IpcHandlerServices>;
} = {
  "controllerUrl.read": () => AppSettings.use((settings) => settings.readControllerUrl),
  "controllerUrl.save": (input) => ControllerConnection.use((connection) => connection.save(input)),
  "token.read": () => StoredToken.use((storedToken) => storedToken.read),
  "token.write": (token) => StoredToken.use((storedToken) => storedToken.write(token)),
  "runnerIdentity.read": ({ port }) => RunnerIdentity.use((identity) => identity.read(port)),
  "firstScreen.report": () => MainWindow.use((window) => window.showFirstTime),
  "goMenu.set": (items) => MainMenu.use((menu) => menu.setGoItems(items)),
  "waiting.set": (requests) =>
    WaitingNotifications.use((notifications) => notifications.setWaitingRequests(requests)),
  "localController.find": () => ThisMac.use((thisMac) => thisMac.findLocalController),
  "localController.start": () => ThisMac.use((thisMac) => thisMac.startLocalController),
  "logsFolder.show": () => ThisMac.use((thisMac) => thisMac.showLogsFolder),
  "setupToken.read": () => ThisMac.use((thisMac) => thisMac.readSetupToken),
  "macUser.read": () => Effect.sync(() => ({ username: userInfo().username })),
  "folder.pick": () => ThisMac.use((thisMac) => thisMac.pickFolder),
  "firstRunProgress.read": () => AppSettings.use((settings) => settings.readFirstRunProgress),
  // The settings file is in the app's own folder, so a write that fails is a
  // defect.
  "firstRunProgress.save": (progress) =>
    AppSettings.use((settings) => settings.saveFirstRunProgress(progress)).pipe(
      Effect.catchTag("PlatformError", Effect.die),
    ),
  "appearance.read": () => AppSettings.use((settings) => settings.readAppearance),
  // As for the first run's progress, a write that fails is a defect.
  "appearance.save": (appearance) =>
    AppSettings.use((settings) => settings.saveAppearance(appearance)).pipe(
      Effect.catchTag("PlatformError", Effect.die),
      Effect.andThen(MainWindow.use((window) => window.paintBackground)),
    ),
  "link.open": ({ url }) => openInBrowser(url),
};

/**
 * Registers the handler of every renderer-to-main channel with Electron. Each
 * message runs on `runtime`: main checks its sender, decodes its request, runs
 * the channel's handler and encodes the response (see `answerIpcMessage`).
 *
 * A synchronous channel's message runs synchronously, and its reply is the
 * event's `returnValue`: the page is blocked until main sets it. Its handler
 * answers from memory, so it never waits. A defect is logged and replied as
 * a refusal rather than thrown: a listener that throws sets no
 * `returnValue`, and the page would stay blocked.
 *
 * Call it once, before the window loads its page.
 */
export const registerIpcHandlers = (
  runtime: ManagedRuntime.ManagedRuntime<IpcHandlerServices, never>,
): void => {
  const registerIpcHandler = <Name extends RendererToMainIpcChannelName>(name: Name) => {
    const answer = (event: IpcMainEvent | IpcMainInvokeEvent, args: ReadonlyArray<unknown>) =>
      answerIpcMessage(name, IPC_HANDLERS[name], {
        senderFrame: event.senderFrame,
        mainFrame: event.sender.mainFrame,
        args,
      });
    const channel: RendererToMainIpcChannel = RENDERER_TO_MAIN_IPC_CHANNELS[name];
    if (channel.synchronous === true) {
      ipcMain.on(name, (event, ...args) => {
        const exit = runtime.runSyncExit(answer(event, args));
        if (Exit.isSuccess(exit)) {
          event.returnValue = exit.value;
          return;
        }
        // The cause stays in main's log: the page needs only to know that
        // the read failed, and a stack trace would tell it about main.
        runtime.runSync(Effect.logError(`Main failed to answer ${name}.`, exit.cause));
        event.returnValue = { refusal: `Main failed to answer ${name}.` };
      });
    } else {
      ipcMain.handle(name, (event, ...args) => runtime.runPromise(answer(event, args)));
    }
  };
  for (const name of Object.keys(
    RENDERER_TO_MAIN_IPC_CHANNELS,
  ) as Array<RendererToMainIpcChannelName>) {
    registerIpcHandler(name);
  }
};
