/**
 * The IPC contract: every channel between the renderer and main, in Effect
 * Schema. Spec 17 (§The IPC contract) lists the channels; a new channel is one
 * more entry in one of the two tables here, added in the same change as its
 * row in that table.
 *
 * - A renderer-to-main channel has a request and a response. Main decodes
 *   every request against this contract before it answers.
 * - A main-to-renderer channel has a payload and no response. Main encodes
 *   every payload against this contract before it sends it.
 * - The preload exposes one function per channel, typed by `./bridge.ts`. It
 *   imports only this file's types, so it loads no Effect at run time, and it
 *   passes requests, responses and payloads through in their encoded form.
 *
 * How a channel reports that something went wrong:
 *
 * - An outcome the user can cause, such as typing an address where no
 *   controller answers, is part of the response, as a union of `_tag`ged
 *   structs. It cannot be a typed rejection: `contextBridge` copies only an
 *   Error's message to the page.
 * - A refusal means the renderer broke the contract. Main refuses a message
 *   from a sender other than the app's main frame, a request that does not
 *   decode, and a request that makes no sense in main's current state. Main
 *   logs the refusal once and replies with its reason, and the bridge function
 *   rejects with an Error that carries the reason. The renderer treats a
 *   refusal as a bug and never shows it to the user.
 * - A defect, a bug in main, makes the bridge function reject too, and
 *   Electron logs it.
 */
import { Schema } from "effect";
import type * as ClientCore from "@hercule/client-core";
import { IDENTITY_PORT, IDENTITY_PORT_COUNT } from "@hercule/contract";
import { isHttpUrl } from "./http-url";

/**
 * An IPC channel the renderer calls and main answers: the renderer sends one
 * request and waits for one response.
 */
export interface RendererToMainIpcChannel {
  /**
   * The request's schema. A channel that needs no request uses
   * `Schema.Undefined`, never `Schema.Void`, which accepts any value.
   */
  readonly request: Schema.Top;
  /**
   * The response's schema. A channel that returns nothing uses `Schema.Void`:
   * main encodes its own response, so accepting any value costs nothing, and
   * the bridge function returns `Promise<void>`.
   */
  readonly response: Schema.Top;
}

/**
 * The outcomes of the connect check for a controller origin, `origin`, where
 * something answered but the app cannot connect. ControllerUrlSaveOutcome
 * describes each; LocalControllerStartOutcome has them too.
 */
const ControllerRefusalCases = {
  Redirected: { origin: Schema.String, targetOrigin: Schema.String },
  NotController: { origin: Schema.String },
  OriginNotAllowed: { origin: Schema.String },
  PreflightRefused: { origin: Schema.String, methods: Schema.Array(Schema.String) },
};

/**
 * What happened when main was asked to save the controller URL the user
 * typed. Only `Saved` saves anything.
 *
 * Every outcome but `InvalidAddress` carries `origin`, the controller's origin
 * main parsed from the text and checked, such as `http://127.0.0.1:4937`.
 * The screen shows it rather than the text, which may differ in spaces,
 * capitals, a trailing `/` or a default port.
 *
 * - `Saved`: a controller answered, set up or not, and its URL is saved.
 *   When the controller is not set up and the text was a setup URL, main
 *   keeps the URL's token in memory, for `setupToken.read`.
 * - `InvalidAddress`: the text is neither an http or https URL with nothing
 *   after the host and port, nor a setup URL: such a URL followed by
 *   `/setup?token=<token>`, as `hercule setup-url` prints it.
 * - `Unreachable`: nothing answered within 5 seconds.
 * - `Redirected`: the origin redirects the controller's API to the same path
 *   at another origin, `targetOrigin`, such as a proxy sending http to https.
 *   Main does not follow it: the user connects to that origin instead. A
 *   redirect anywhere else is `NotController`.
 * - `NotController`: something answered, but not a Hercule controller.
 * - `OriginNotAllowed`: a controller answered, but it does not accept requests
 *   from the desktop app: it is older than the desktop app.
 * - `PreflightRefused`: the controller accepts the desktop app, but the CORS
 *   preflight refuses the app's calls with each method in `methods`, such as
 *   `DELETE`, as a proxy in front of the controller can.
 */
export const ControllerUrlSaveOutcome = Schema.TaggedUnion({
  Saved: { origin: Schema.String },
  InvalidAddress: {},
  Unreachable: { origin: Schema.String },
  ...ControllerRefusalCases,
});
export type ControllerUrlSaveOutcome = typeof ControllerUrlSaveOutcome.Type;

/**
 * What main found when it looked for Hercule on this Mac, with
 * `hercule service status --json`, at a launch with no controller URL saved.
 * Main saves nothing and checks nothing.
 *
 * - `Found`: the binary reported `origin`, the address Hercule's controller
 *   on this Mac opens at. Whether anything answers there is not checked.
 *   The renderer saves it through `controllerUrl.save`, which runs the
 *   connect check first: a controller that answers is saved and the window
 *   reloads, and any other outcome means Hercule was not found.
 * - `Runner`: this Mac's Service Unit runs a runner, not Hercule's
 *   controller. `running` is true when its process runs. Main never
 *   installs over it: that would restart the runner and end its sessions.
 * - `NotFound`: main found no address. `line` is the line the status command
 *   failed with, or null when nothing went wrong: there is no binary, or the
 *   default Hercule Home's `config.toml` cannot be read.
 */
export const LocalControllerFindOutcome = Schema.TaggedUnion({
  Found: { origin: Schema.String },
  Runner: { running: Schema.Boolean },
  NotFound: { line: Schema.NullOr(Schema.String) },
});
export type LocalControllerFindOutcome = typeof LocalControllerFindOutcome.Type;

/**
 * What happened when main started Hercule on this Mac with
 * `hercule service install --json`, or found it already running.
 *
 * - `Saved`: Hercule answered. Main saved its URL and reloaded the window.
 * - `Runner`: this Mac's Service Unit runs a runner; `running` is true when
 *   its process runs. Either the Service Unit already ran one, and main
 *   installed nothing, or the Hercule Home is a runner's, so the install set
 *   up the runner.
 * - `NotInstalled`: there is no Hercule binary at `~/.local/bin/hercule`.
 * - `StartFailed`: a step failed. `line` is the last line the binary wrote to
 *   stderr, without its `hercule: ` prefix, or why main could not read the
 *   user's `PATH` from their login shell.
 * - `NoAnswer`: Hercule was started, but nothing answered at `origin`
 *   within 30 seconds, or the command still ran after 90 seconds and main
 *   stopped it. `logsFolder` is the Hercule Home's logs folder, which may say
 *   why; `logsFolder.show` opens it.
 * - `Redirected`, `NotController`, `OriginNotAllowed` and
 *   `PreflightRefused`: something answered at `origin`, but the connect
 *   check refused it, as for `controllerUrl.save`. Main stops waiting at
 *   once: waiting would not change the answer.
 */
export const LocalControllerStartOutcome = Schema.TaggedUnion({
  Saved: { origin: Schema.String },
  Runner: { running: Schema.Boolean },
  NotInstalled: {},
  StartFailed: { line: Schema.String },
  NoAnswer: { origin: Schema.String, logsFolder: Schema.String },
  ...ControllerRefusalCases,
});
export type LocalControllerStartOutcome = typeof LocalControllerStartOutcome.Type;

/**
 * Where main found the setup token of the saved controller.
 *
 * - `Token`: the token, from the setup URL the user pasted, or from
 *   `hercule setup-url` on this Mac when it names the saved controller.
 * - `PasteNeeded`: main has no token for the saved controller. The user runs
 *   `hercule setup-url` on the controller's machine and pastes the setup
 *   URL it prints.
 */
export const SetupTokenReadOutcome = Schema.TaggedUnion({
  Token: { token: Schema.String },
  PasteNeeded: {},
});
export type SetupTokenReadOutcome = typeof SetupTokenReadOutcome.Type;

/**
 * The folder the user picked for a project, as git describes it. `name` is
 * the folder's own name, such as `api` for `/Users/me/code/api`, and
 * `branch` is the branch checked out, or null when none is (a detached
 * HEAD).
 *
 * - `Cancelled`: the user closed the dialog without picking a folder.
 * - `Repository`: a git repository whose `origin` remote is at `remote`,
 *   with no user name or password in it.
 * - `NoRemote`: a git repository with no `origin` remote.
 * - `NotGit`: a folder that is not in a git repository.
 * - `GitFailed`: git could not read the folder for another reason, such as
 *   git not being installed. `line` is the last line git wrote to stderr.
 */
export const FolderPickOutcome = Schema.TaggedUnion({
  Cancelled: {},
  Repository: { name: Schema.String, remote: Schema.String, branch: Schema.NullOr(Schema.String) },
  NoRemote: { name: Schema.String, branch: Schema.NullOr(Schema.String) },
  NotGit: { name: Schema.String },
  GitFailed: { name: Schema.String, line: Schema.String },
});
export type FolderPickOutcome = typeof FolderPickOutcome.Type;

/**
 * A step of the first run, in the order the first run shows them. Client-core
 * owns the steps, as `FIRST_RUN_STEPS`. The list is spelled again here,
 * checked against client-core's, because main imports client-core only as
 * types: a runtime import would add client-core to main's startup file.
 */
export const FirstRunStep = Schema.Literals([
  "account",
  "providers",
  "github",
  "project",
] satisfies typeof ClientCore.FIRST_RUN_STEPS);
export type FirstRunStep = ClientCore.FirstRunStep;

/** What main keeps of the first run for the saved controller: the steps the user put off. */
export const FirstRunProgress = Schema.Struct({ putOff: Schema.Array(FirstRunStep) });
export type FirstRunProgress = typeof FirstRunProgress.Type;

/** An absolute `http:` or `https:` URL. */
const HttpUrl = Schema.String.check(
  Schema.makeFilter((url: string) =>
    isHttpUrl(url) ? undefined : `Expected an http: or https: URL, got ${url}`,
  ),
);

/** A menu item the page carries out: Sign Out, New Thread, Office, Settings, or Send. */
export const MenuCommand = Schema.Literals([
  "signOut",
  "newThread",
  "openOffice",
  "openSettings",
  "send",
]);
export type MenuCommand = typeof MenuCommand.Type;

/** A thread the Go menu lists: the session it opens, and the title its item shows. */
export const GoMenuThread = Schema.Struct({ sessionId: Schema.String, title: Schema.String });
export type GoMenuThread = typeof GoMenuThread.Type;

/**
 * A thread waiting on the user, as client-core's `listWaitingThreads` returns
 * it. The schema's fields must match client-core's type one for one, so a
 * field added to one and not the other fails the typecheck.
 */
export const WaitingThread = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  body: Schema.String,
  openRequestIds: Schema.Array(Schema.String),
} satisfies {
  readonly [Field in keyof ClientCore.WaitingThread]: Schema.Codec<ClientCore.WaitingThread[Field]>;
});
export type WaitingThread = ClientCore.WaitingThread;

/**
 * The IPC channels from the renderer to main, keyed by name. A name is
 * `<entity>.<verb>`, like an operation id in the public API, and the bridge
 * exposes the channel as `window.bridge.<entity>.<verb>()`.
 */
export const RENDERER_TO_MAIN_IPC_CHANNELS = {
  /** Reads the controller URL saved in the app's settings, or null when none is saved yet. */
  "controllerUrl.read": {
    request: Schema.Undefined,
    response: Schema.NullOr(Schema.String),
  },
  /**
   * Checks the controller at the address the user typed and, when it is ready
   * for the desktop app, saves its URL and reloads the window. The address is
   * a controller's origin, or a setup URL, which carries the setup token
   * too. Saving a different controller signs the user out and removes the
   * stored token.
   */
  "controllerUrl.save": {
    request: Schema.String,
    response: ControllerUrlSaveOutcome,
  },
  /** Reads the stored login token, or null when there is none. */
  "token.read": {
    request: Schema.Undefined,
    response: Schema.NullOr(Schema.String),
  },
  /**
   * Stores the login token, encrypted with the Keychain, or removes it when
   * the request is null. Refused when no controller URL is saved, because a
   * token belongs to one controller.
   */
  "token.write": {
    request: Schema.NullOr(Schema.NonEmptyString),
    response: Schema.Void,
  },
  /**
   * Returns the id of the runner that answers on 127.0.0.1 at the port, or
   * null when nothing answers there, or something that is not a runner does.
   * Main sends only `GET http://127.0.0.1:<port>/identity`: the request names
   * the port and nothing else. See spec 17 (§The "local" runner).
   *
   * Only the ten ports a runner's identity endpoint can listen on are
   * accepted. Any other port would let the page make main probe every
   * service on the Mac. The web app's Content Security Policy limits its page
   * to the same ten ports for the same reason.
   */
  "runnerIdentity.read": {
    request: Schema.Struct({
      port: Schema.Int.check(
        Schema.isBetween({
          minimum: IDENTITY_PORT,
          maximum: IDENTITY_PORT + IDENTITY_PORT_COUNT - 1,
        }),
      ),
    }),
    response: Schema.NullOr(Schema.String),
  },
  /**
   * Reports that the frame that draws the page's first screen, fonts
   * included, has reached the window. Main shows the window if it has not
   * shown yet, and otherwise does nothing: the page reports again after each
   * reload, and more than one screen can report at launch, so a second report
   * is normal and never refused.
   */
  "firstScreen.report": {
    request: Schema.Undefined,
    response: Schema.Void,
  },
  /**
   * Sends the first nine threads the sidebar shows, top to bottom, each once,
   * for the Go menu: one per shortcut, ⌘1 to ⌘9. Choosing one shows the
   * window and opens it through `thread.open`. Main cannot read the sidebar,
   * so the renderer sends the list each time it changes.
   */
  "goMenu.set": {
    request: Schema.Array(GoMenuThread).check(Schema.isMaxLength(9)),
    response: Schema.Void,
  },
  /**
   * Sends every thread waiting on the user, whenever the thread list
   * changes. Main counts them on the dock badge and shows a native
   * notification for each Request that opens (see `ThreadNotifications`).
   * Main cannot read the thread list, so the renderer sends it; main keeps
   * what it has shown, so a list sent twice, as after a reload, shows
   * nothing twice.
   */
  "waitingThreads.set": {
    request: Schema.Array(WaitingThread),
    response: Schema.Void,
  },
  /**
   * Looks for Hercule on this Mac and returns the address it opens at. Saves
   * nothing: the renderer saves the address through `controllerUrl.save`.
   * Refused when a controller URL is saved: the first run looks only before
   * one is.
   */
  "localController.find": {
    request: Schema.Undefined,
    response: LocalControllerFindOutcome,
  },
  /**
   * Starts Hercule on this Mac as a Service Unit, waits for it to answer, and
   * saves its URL. Takes up to two minutes. Refused when a controller URL is
   * saved, and while a start runs: the renderer waits for the first.
   */
  "localController.start": {
    request: Schema.Undefined,
    response: LocalControllerStartOutcome,
  },
  /**
   * Opens in Finder the logs folder of the Hercule Home on this Mac, as the
   * binary last reported it to `localController.find` or
   * `localController.start`. Refused before the binary has reported one.
   */
  "logsFolder.show": {
    request: Schema.Undefined,
    response: Schema.Void,
  },
  /**
   * Reads the setup token of the saved controller. A pasted token is
   * returned once. Refused when no controller URL is saved.
   */
  "setupToken.read": {
    request: Schema.Undefined,
    response: SetupTokenReadOutcome,
  },
  /** Reads the name of the user's account on this Mac, such as `rogier`. */
  "macUser.read": {
    request: Schema.Undefined,
    response: Schema.Struct({ username: Schema.String }),
  },
  /**
   * Asks the user to pick a folder in the system's dialog, and describes it
   * with git. Main never changes the folder.
   */
  "folder.pick": {
    request: Schema.Undefined,
    response: FolderPickOutcome,
  },
  /**
   * Reads the first-run steps the user put off for the saved controller, or
   * null when main keeps none for that controller.
   */
  "firstRunProgress.read": {
    request: Schema.Undefined,
    response: Schema.NullOr(FirstRunProgress),
  },
  /**
   * Saves the first-run steps the user put off for the saved controller, or
   * removes them when the request is null. Refused when no controller URL is
   * saved.
   */
  "firstRunProgress.save": {
    request: Schema.NullOr(FirstRunProgress),
    response: Schema.Void,
  },
  /** Opens an `http:` or `https:` URL in the default browser. Refuses any other URL. */
  "link.open": {
    request: Schema.Struct({ url: HttpUrl }),
    response: Schema.Void,
  },
} as const satisfies Record<`${string}.${string}`, RendererToMainIpcChannel>;

/** The name of a renderer-to-main channel, such as `controllerUrl.read`. */
export type RendererToMainIpcChannelName = keyof typeof RENDERER_TO_MAIN_IPC_CHANNELS;

/** The request of the renderer-to-main channel `Name`, as main decodes it. */
export type IpcRequest<Name extends RendererToMainIpcChannelName> =
  (typeof RENDERER_TO_MAIN_IPC_CHANNELS)[Name]["request"]["Type"];

/** The request of the renderer-to-main channel `Name`, in the form the renderer sends it. */
export type EncodedIpcRequest<Name extends RendererToMainIpcChannelName> =
  (typeof RENDERER_TO_MAIN_IPC_CHANNELS)[Name]["request"]["Encoded"];

/** The response of the renderer-to-main channel `Name`, before main encodes it. */
export type IpcResponse<Name extends RendererToMainIpcChannelName> =
  (typeof RENDERER_TO_MAIN_IPC_CHANNELS)[Name]["response"]["Type"];

/** The response of the renderer-to-main channel `Name`, in the form the renderer receives it. */
export type EncodedIpcResponse<Name extends RendererToMainIpcChannelName> =
  (typeof RENDERER_TO_MAIN_IPC_CHANNELS)[Name]["response"]["Encoded"];

/**
 * An IPC channel main sends on and the renderer listens to. The renderer
 * sends nothing back.
 */
export interface MainToRendererIpcChannel {
  readonly payload: Schema.Top;
}

/**
 * The IPC channels from main to the renderer, keyed by name. A name is
 * `<entity>.<verb>`, and the bridge exposes the channel as
 * `window.bridge.<entity>.on<Verb>(listener)`, which returns a function that
 * removes the listener. The listener gets the payload alone, never Electron's
 * IPC event object, whose `sender` is `ipcRenderer` itself and would let the
 * page send anything on any channel.
 */
export const MAIN_TO_RENDERER_IPC_CHANNELS = {
  /**
   * Asks the renderer to carry out a menu item the user chose: Sign Out, New
   * Thread, Office, Settings, or Send.
   */
  "menu.command": {
    payload: MenuCommand,
  },
  /** Asks the renderer to open a thread: its notification or its Go menu item was chosen. */
  "thread.open": {
    payload: Schema.Struct({ sessionId: Schema.String }),
  },
} as const satisfies Record<`${string}.${string}`, MainToRendererIpcChannel>;

/** The name of a main-to-renderer channel, such as `menu.command`. */
export type MainToRendererIpcChannelName = keyof typeof MAIN_TO_RENDERER_IPC_CHANNELS;

/** The payload of the main-to-renderer channel `Name`, before main encodes it. */
export type IpcPayload<Name extends MainToRendererIpcChannelName> =
  (typeof MAIN_TO_RENDERER_IPC_CHANNELS)[Name]["payload"]["Type"];

/** The payload of the main-to-renderer channel `Name`, in the form the renderer receives it. */
export type EncodedIpcPayload<Name extends MainToRendererIpcChannelName> =
  (typeof MAIN_TO_RENDERER_IPC_CHANNELS)[Name]["payload"]["Encoded"];

/**
 * What main sends back for one message on a renderer-to-main channel: the
 * encoded response, or the reason main refused the message. A refusal is a
 * value rather than a rejected promise, because Electron prints every
 * rejected handler to the console and main logs each refusal itself.
 */
export type IpcReply<Response> = { readonly response: Response } | { readonly refusal: string };
