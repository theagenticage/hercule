/**
 * The IPC contract: every channel between the renderer and main, each with its
 * name, its request and its response in Effect Schema. Spec 17 (§The IPC
 * contract) lists the channels; a new channel is one more entry here, added in
 * the same change as its row in that table.
 *
 * - Main decodes every request against this contract before it answers.
 * - The preload exposes one function per channel, typed by `./bridge.ts`. It
 *   imports only this file's types, so it loads no Effect at run time.
 *
 * A request and a response cross the process boundary in their encoded form,
 * copied by Electron's structured clone.
 */
import { Schema } from "effect";

/**
 * An IPC channel the renderer calls and main answers: the renderer sends one
 * request and waits for one response.
 */
export interface RendererToMainIpcChannel {
  /** The request's schema. A channel that needs no request uses `Schema.Undefined`. */
  readonly request: Schema.Top;
  readonly response: Schema.Top;
}

/**
 * The IPC channels from the renderer to main, keyed by name. A name is
 * `<entity>.<verb>`, like an operation id in the public API, and the bridge
 * exposes the channel as `window.bridge.<entity>.<verb>()`.
 *
 * Channels from main to the renderer are not built yet. The first one brings
 * a second table, shaped like this one, with a payload schema and no response,
 * because the renderer sends nothing back:
 *
 * - A name is `<entity>.<verb>` too, such as `thread.open`.
 * - Main encodes the payload against the table and sends it with
 *   `webContents.send`.
 * - The bridge exposes the channel as `window.bridge.thread.onOpen(listener)`,
 *   which returns a function that removes the listener.
 * - The preload calls `listener` with the payload alone. It never passes on
 *   Electron's IPC event object, whose `sender` is `ipcRenderer` itself and
 *   would let the page send anything on any channel.
 */
export const RENDERER_TO_MAIN_IPC_CHANNELS = {
  /** Reads the controller URL saved in the app's settings, or null when none is saved yet. */
  "controllerUrl.read": {
    request: Schema.Undefined,
    response: Schema.NullOr(Schema.String),
  },
} as const satisfies Record<`${string}.${string}`, RendererToMainIpcChannel>;

/**
 * What main sends back for one message on a renderer-to-main channel: the
 * encoded response, or the reason main refused the message. A refusal is a
 * value rather than a rejected promise, because Electron prints every
 * rejected handler to the console and main logs each refusal itself.
 */
export type IpcReply<Response> = { readonly response: Response } | { readonly refusal: string };
