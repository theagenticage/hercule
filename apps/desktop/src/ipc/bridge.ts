/**
 * The types of the bridge: the object the preload exposes to the renderer as
 * `window.bridge`, with one function per channel of the IPC contract, and the
 * platform the app runs on. The functions are derived from the contract, so a
 * channel with no bridge function, or a function whose types differ from its
 * channel's, is a type error in the preload.
 *
 * This file holds types only. The preload and the renderer import it with
 * `import type`, so neither loads the contract, nor Effect, at run time.
 */
import type { DesktopPlatform } from "./platform/desktop-platform";
import type {
  EncodedIpcPayload,
  EncodedIpcRequest,
  EncodedIpcResponse,
  MainToRendererIpcChannelName,
  RENDERER_TO_MAIN_IPC_CHANNELS,
  RendererToMainIpcChannelName,
} from "./contract";

/**
 * What the bridge function of the renderer-to-main channel `Name` returns:
 * the response itself on a synchronous channel, and a promise of it on any
 * other.
 */
type BridgeResult<Name extends RendererToMainIpcChannelName> =
  (typeof RENDERER_TO_MAIN_IPC_CHANNELS)[Name] extends { readonly synchronous: true }
    ? EncodedIpcResponse<Name>
    : Promise<EncodedIpcResponse<Name>>;

/**
 * The bridge function of one renderer-to-main channel. It takes no argument
 * when the channel needs no request. When main refuses the message, it
 * throws, or its promise rejects, with main's reason.
 */
type BridgeFunction<Name extends RendererToMainIpcChannelName> =
  EncodedIpcRequest<Name> extends undefined
    ? () => BridgeResult<Name>
    : (request: EncodedIpcRequest<Name>) => BridgeResult<Name>;

/**
 * The bridge function of one main-to-renderer channel. It calls `listener`
 * with each payload main sends, and returns a function that removes the
 * listener.
 */
type BridgeSubscription<Name extends MainToRendererIpcChannelName> = (
  listener: (payload: EncodedIpcPayload<Name>) => void,
) => () => void;

/**
 * The `<entity>` part of a channel name. Given a union of names, it is the
 * union of their entities, because a conditional type on a type parameter
 * applies to each member of a union.
 */
type IpcChannelEntity<Name> = Name extends `${infer Entity}.${string}` ? Entity : never;

/**
 * The bridge, grouped the way the channels are named:
 *
 * - the renderer-to-main channel `controllerUrl.read` is the function
 *   `controllerUrl.read()`;
 * - the main-to-renderer channel `menu.command` is the function
 *   `menu.onCommand(listener)`.
 *
 * Besides the channels, the bridge holds `platform`, the operating system the
 * app runs on. The page reads it here, not from the browser's own
 * `navigator.platform`, so a page drawn outside the app, such as the
 * specimens and the screenshots of the goldens, says which platform it draws.
 */
export type Bridge = BridgeChannels & { readonly platform: DesktopPlatform };

type BridgeChannels = {
  readonly [
    Entity in IpcChannelEntity<RendererToMainIpcChannelName | MainToRendererIpcChannelName>
  ]: {
    readonly [
      Name in RendererToMainIpcChannelName as Name extends `${Entity}.${infer Verb}` ? Verb : never
    ]: BridgeFunction<Name>;
  } & {
    readonly [
      Name in MainToRendererIpcChannelName as Name extends `${Entity}.${infer Verb}`
        ? `on${Capitalize<Verb>}`
        : never
    ]: BridgeSubscription<Name>;
  };
};
