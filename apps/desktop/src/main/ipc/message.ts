/**
 * How main answers one IPC message on a renderer-to-main channel: it checks
 * who sent the message, decodes the request, runs the channel's handler and
 * encodes the response. A message that fails a check, or whose handler
 * fails, is refused: main logs it once and replies with the reason.
 *
 * Nothing here imports Electron, so the checks run in unit tests.
 */
import { DESKTOP_APP_ORIGIN } from "@hercule/contract";
import { Data, Effect, Schema } from "effect";
import {
  type EncodedIpcResponse,
  type IpcReply,
  type IpcRequest,
  type IpcResponse,
  RENDERER_TO_MAIN_IPC_CHANNELS,
  type RendererToMainIpcChannelName,
} from "../../ipc/contract";

/** The part of Electron's `WebFrameMain` that the sender check reads. */
interface WebFrame {
  readonly origin: string;
}

/**
 * The error a check of an IPC message fails with. `message` is the reason
 * main refuses the message; it goes back to the renderer and into main's log.
 */
class IpcMessageRefused extends Data.TaggedError("IpcMessageRefused")<{
  readonly message: string;
}> {}

/**
 * Checks that an IPC message comes from the window's page: `senderFrame` must
 * be the main frame of the web contents that sent the message, not a frame
 * inside the page, and its origin must be `DESKTOP_APP_ORIGIN`. Fails with
 * IpcMessageRefused otherwise. `senderFrame` is null when the frame navigated
 * away or closed before main read the message.
 *
 * Electron hands out one `WebFrameMain` object per frame, so comparing the
 * two objects compares the frames.
 */
const checkIpcSender = (
  senderFrame: WebFrame | null,
  mainFrame: WebFrame,
): Effect.Effect<void, IpcMessageRefused> => {
  if (senderFrame === null) {
    return Effect.fail(new IpcMessageRefused({ message: "the frame that sent it is gone" }));
  }
  if (senderFrame !== mainFrame) {
    return Effect.fail(new IpcMessageRefused({ message: "it comes from a frame inside the page" }));
  }
  if (senderFrame.origin !== DESKTOP_APP_ORIGIN) {
    return Effect.fail(
      new IpcMessageRefused({
        message: `it comes from ${senderFrame.origin}, not ${DESKTOP_APP_ORIGIN}`,
      }),
    );
  }
  return Effect.void;
};

/**
 * Decodes the request of one IPC message from its arguments. A message
 * carries at most one argument, the request, and none when the channel needs
 * no request. Fails with IpcMessageRefused when there are more arguments or
 * the request does not match the channel's schema.
 *
 * A channel that needs no request is sent with no argument rather than with
 * `undefined`, because Electron turns an `undefined` argument into `null`.
 */
const decodeIpcRequest = <IpcRequestSchema extends Schema.Top>(
  schema: IpcRequestSchema,
  args: ReadonlyArray<unknown>,
): Effect.Effect<
  IpcRequestSchema["Type"],
  IpcMessageRefused,
  IpcRequestSchema["DecodingServices"]
> => {
  if (args.length > 1) {
    return Effect.fail(
      new IpcMessageRefused({
        message: `it carries ${args.length} arguments, and a message carries at most one, the request`,
      }),
    );
  }
  return Schema.decodeUnknownEffect(schema)(args[0]).pipe(
    Effect.mapError(
      (error) =>
        new IpcMessageRefused({
          message: `its request does not match the contract: ${error.message}`,
        }),
    ),
  );
};

/** One IPC message as main receives it from Electron. */
export interface IpcMessage {
  /** The frame that sent the message: Electron's `event.senderFrame`. */
  readonly senderFrame: WebFrame | null;
  /** The main frame of the web contents that sent it: `event.sender.mainFrame`. */
  readonly mainFrame: WebFrame;
  /** The arguments the renderer passed after the channel name. */
  readonly args: ReadonlyArray<unknown>;
}

/**
 * Answers one IPC message on the channel `name`: checks its sender, decodes
 * its request, runs `handler` and encodes the response. Returns the reply for
 * the renderer, which holds the encoded response, or the reason main refused
 * the message; a refusal is also logged, once, as a warning.
 *
 * `handler` fails only when the request makes no sense in main's current
 * state, and main then refuses the message, with the error's message as the
 * reason, as it refuses one that does not decode. A response that does not
 * encode is a bug in main, not the renderer's fault, so it is a defect rather
 * than a refusal.
 */
export const answerIpcMessage = <
  Name extends RendererToMainIpcChannelName,
  HandlerError extends Error,
  Services,
>(
  name: Name,
  handler: (request: IpcRequest<Name>) => Effect.Effect<IpcResponse<Name>, HandlerError, Services>,
  message: IpcMessage,
): Effect.Effect<IpcReply<EncodedIpcResponse<Name>>, never, Services> =>
  Effect.gen(function* () {
    const channel = RENDERER_TO_MAIN_IPC_CHANNELS[name];
    yield* checkIpcSender(message.senderFrame, message.mainFrame);
    const request = yield* decodeIpcRequest(channel.request, message.args);
    const response = yield* handler(request);
    return { response: yield* Effect.orDie(Schema.encodeEffect(channel.response)(response)) };
  }).pipe(
    Effect.catch((error) => {
      const refusal = `Main refused a message on ${name}: ${error.message}.`;
      return Effect.as(Effect.logWarning(refusal), { refusal });
    }),
  );
