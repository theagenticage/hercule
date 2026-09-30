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
 * What happened when main was asked to save the controller URL the user
 * typed. Only `Saved` saves anything.
 *
 * Every outcome but `InvalidUrl` carries `origin`, the controller's origin
 * main parsed from the text and checked, such as `http://127.0.0.1:4937`.
 * The screen shows it rather than the text, which may differ in spaces,
 * capitals, a trailing `/` or a default port.
 *
 * - `Saved`: a set-up controller answered, and its URL is saved.
 * - `InvalidUrl`: the text is not an http or https URL with nothing after
 *   the host and port.
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
 * - `SetupIncomplete`: the controller is not set up yet. Main has opened its
 *   setup page in the browser.
 */
export const ControllerUrlSaveOutcome = Schema.TaggedUnion({
  Saved: { origin: Schema.String },
  InvalidUrl: {},
  Unreachable: { origin: Schema.String },
  Redirected: { origin: Schema.String, targetOrigin: Schema.String },
  NotController: { origin: Schema.String },
  OriginNotAllowed: { origin: Schema.String },
  PreflightRefused: { origin: Schema.String, methods: Schema.Array(Schema.String) },
  SetupIncomplete: { origin: Schema.String },
});
export type ControllerUrlSaveOutcome = typeof ControllerUrlSaveOutcome.Type;

/** A menu item the page carries out: Sign Out, New Thread, or Send. */
export const MenuCommand = Schema.Literals(["signOut", "newThread", "send"]);
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
  requestId: Schema.String,
  title: Schema.String,
  question: Schema.String,
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
   * Checks the controller at the URL the user typed and, when it is ready for
   * the desktop app, saves the URL and reloads the window. Saving a different
   * controller signs the user out and removes the stored token.
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
} as const satisfies Record<`${string}.${string}`, RendererToMainIpcChannel>;

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
   * Thread, or Send.
   */
  "menu.command": {
    payload: MenuCommand,
  },
  /** Asks the renderer to open a thread: its notification or its Go menu item was chosen. */
  "thread.open": {
    payload: Schema.Struct({ sessionId: Schema.String }),
  },
} as const satisfies Record<`${string}.${string}`, MainToRendererIpcChannel>;

/**
 * What main sends back for one message on a renderer-to-main channel: the
 * encoded response, or the reason main refused the message. A refusal is a
 * value rather than a rejected promise, because Electron prints every
 * rejected handler to the console and main logs each refusal itself.
 */
export type IpcReply<Response> = { readonly response: Response } | { readonly refusal: string };
