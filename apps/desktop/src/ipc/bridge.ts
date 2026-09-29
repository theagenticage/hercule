/**
 * The types of the bridge: the object the preload exposes to the renderer as
 * `window.bridge`, with one function per channel of the IPC contract. They
 * are derived from the contract, so a channel with no bridge function, or a
 * function whose types differ from its channel's, is a type error in the
 * preload.
 *
 * This file holds types only. The preload and the renderer import it with
 * `import type`, so neither loads the contract, nor Effect, at run time.
 */
import type { RENDERER_TO_MAIN_IPC_CHANNELS } from "./contract";

type RendererToMainIpcChannels = typeof RENDERER_TO_MAIN_IPC_CHANNELS;

/** The name of a renderer-to-main channel, such as `controllerUrl.read`. */
export type RendererToMainIpcChannelName = keyof RendererToMainIpcChannels;

/** The request of a channel in the form the renderer sends it. */
export type EncodedIpcRequest<Name extends RendererToMainIpcChannelName> =
  RendererToMainIpcChannels[Name]["request"]["Encoded"];

/** The response of a channel in the form the renderer receives it. */
export type EncodedIpcResponse<Name extends RendererToMainIpcChannelName> =
  RendererToMainIpcChannels[Name]["response"]["Encoded"];

/**
 * The bridge function of one channel. It takes no argument when the channel
 * needs no request. Its promise rejects with main's reason when main refuses
 * the message.
 */
type BridgeFunction<Name extends RendererToMainIpcChannelName> =
  EncodedIpcRequest<Name> extends undefined
    ? () => Promise<EncodedIpcResponse<Name>>
    : (request: EncodedIpcRequest<Name>) => Promise<EncodedIpcResponse<Name>>;

/**
 * The `<entity>` part of a channel name. Given a union of names, it is the
 * union of their entities, because a conditional type on a type parameter
 * applies to each member of a union.
 */
type IpcChannelEntity<Name> = Name extends `${infer Entity}.${string}` ? Entity : never;

/**
 * The bridge, grouped the way the channels are named: the channel
 * `controllerUrl.read` is the function `controllerUrl.read()`.
 */
export type Bridge = {
  readonly [Entity in IpcChannelEntity<RendererToMainIpcChannelName>]: {
    readonly [
      Name in RendererToMainIpcChannelName as Name extends `${Entity}.${infer Verb}` ? Verb : never
    ]: BridgeFunction<Name>;
  };
};
