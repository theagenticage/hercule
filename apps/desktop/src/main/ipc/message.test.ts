/**
 * Tests how main answers one IPC message: the sender check, the decoding of
 * the request, and the reply and log line of a refused message. The frames
 * are plain objects, so no test needs Electron.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Logger, Schema } from "effect";
import { RENDERER_TO_MAIN_IPC_CHANNELS } from "../../ipc/contract";
import {
  answerIpcMessage,
  checkIpcSender,
  decodeIpcRequest,
  IpcMessageRefused,
  type WebFrame,
} from "./message";

const mainFrame: WebFrame = { origin: "app://hercule" };

/** Returns the reason an effect was refused for, or fails the test when it was not refused. */
const readRefusal = <A>(effect: Effect.Effect<A, IpcMessageRefused>): string => {
  const exit = Effect.runSyncExit(Effect.flip(effect));
  if (Exit.isFailure(exit)) throw new Error("the effect was not refused");
  return exit.value.message;
};

describe("checkIpcSender", () => {
  it("accepts the main frame at app://hercule", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(checkIpcSender(mainFrame, mainFrame)))).toBe(true);
  });

  it("refuses a frame inside the page, even at app://hercule", () => {
    const subframe: WebFrame = { origin: "app://hercule" };
    expect(readRefusal(checkIpcSender(subframe, mainFrame))).toBe(
      "it comes from a frame inside the page",
    );
  });

  it("refuses a main frame at any other origin", () => {
    const page: WebFrame = { origin: "http://127.0.0.1:5173" };
    expect(readRefusal(checkIpcSender(page, page))).toBe(
      "it comes from http://127.0.0.1:5173, not app://hercule",
    );
  });

  it("refuses an origin that only starts with app://hercule", () => {
    const page: WebFrame = { origin: "app://hercule.example" };
    expect(readRefusal(checkIpcSender(page, page))).toContain("not app://hercule");
  });

  it("refuses a message whose frame is gone", () => {
    expect(readRefusal(checkIpcSender(null, mainFrame))).toBe("the frame that sent it is gone");
  });
});

describe("decodeIpcRequest", () => {
  it("decodes a message with no argument as the request undefined", () => {
    expect(Effect.runSync(decodeIpcRequest(Schema.Undefined, []))).toBeUndefined();
  });

  it("decodes the one argument against the schema", () => {
    expect(Effect.runSync(decodeIpcRequest(Schema.Number, [42]))).toBe(42);
  });

  it("refuses an argument that does not match the schema", () => {
    expect(readRefusal(decodeIpcRequest(Schema.Undefined, [42]))).toMatch(
      /^its request does not match the contract: .+/,
    );
  });

  it("refuses a message with more than one argument", () => {
    expect(readRefusal(decodeIpcRequest(Schema.Number, [1, 2]))).toBe(
      "it carries 2 arguments, and a message carries at most one, the request",
    );
  });
});

describe("the requests of the renderer-to-main channels", () => {
  const cases: ReadonlyArray<{
    readonly name: keyof typeof RENDERER_TO_MAIN_IPC_CHANNELS;
    readonly valid: ReadonlyArray<unknown>;
    readonly invalid: ReadonlyArray<unknown>;
  }> = [
    { name: "controllerUrl.read", valid: [], invalid: [42] },
    { name: "controllerUrl.save", valid: ["http://127.0.0.1:4937"], invalid: [42] },
    { name: "token.read", valid: [], invalid: ["a token"] },
    { name: "token.write", valid: ["a token"], invalid: [42] },
    { name: "token.write", valid: [null], invalid: [""] },
    // Only the ten ports a runner's identity endpoint can listen on.
    { name: "runnerIdentity.read", valid: [{ port: 4939 }], invalid: [{ port: 4938 }] },
    { name: "runnerIdentity.read", valid: [{ port: 4948 }], invalid: [{ port: 4949 }] },
    { name: "runnerIdentity.read", valid: [{ port: 4940 }], invalid: [{ port: 22 }] },
  ];

  it.each(cases)("$name decodes $valid and refuses $invalid", ({ name, valid, invalid }) => {
    const schema = RENDERER_TO_MAIN_IPC_CHANNELS[name].request;
    expect(Effect.runSync(decodeIpcRequest(schema, valid))).toEqual(valid[0]);
    expect(readRefusal(decodeIpcRequest(schema, invalid))).toMatch(
      /^its request does not match the contract: .+/,
    );
  });
});

describe("answerIpcMessage", () => {
  const channel = RENDERER_TO_MAIN_IPC_CHANNELS["controllerUrl.read"];
  const readUrl = () => Effect.succeed("http://127.0.0.1:4937");

  it("replies with the handler's response", () => {
    const reply = Effect.runSync(
      answerIpcMessage("controllerUrl.read", channel, readUrl, {
        senderFrame: mainFrame,
        mainFrame,
        args: [],
      }),
    );
    expect(reply).toEqual({ response: "http://127.0.0.1:4937" });
  });

  it("replies with the refusal, and does not run the handler, when the request does not decode", () => {
    let ran = false;
    const reply = Effect.runSync(
      answerIpcMessage(
        "controllerUrl.read",
        channel,
        () =>
          Effect.sync(() => {
            ran = true;
            return null;
          }),
        { senderFrame: mainFrame, mainFrame, args: [42] },
      ),
    );
    expect(ran).toBe(false);
    expect(reply).toEqual({
      refusal:
        "Main refused a message on controllerUrl.read: its request does not match the contract: Expected undefined.",
    });
  });

  it("replies with the refusal, the error's message as the reason, when the handler fails", () => {
    const reply = Effect.runSync(
      answerIpcMessage(
        "token.write",
        RENDERER_TO_MAIN_IPC_CHANNELS["token.write"],
        () => Effect.fail(new Error("no controller URL is saved")),
        { senderFrame: mainFrame, mainFrame, args: ["a token"] },
      ),
    );
    expect(reply).toEqual({
      refusal: "Main refused a message on token.write: no controller URL is saved.",
    });
  });

  it("replies with an outcome the user caused as the response", () => {
    const reply = Effect.runSync(
      answerIpcMessage(
        "controllerUrl.save",
        RENDERER_TO_MAIN_IPC_CHANNELS["controllerUrl.save"],
        () => Effect.succeed({ _tag: "Unreachable", origin: "http://127.0.0.1:1" } as const),
        { senderFrame: mainFrame, mainFrame, args: ["http://127.0.0.1:1"] },
      ),
    );
    expect(reply).toEqual({ response: { _tag: "Unreachable", origin: "http://127.0.0.1:1" } });
  });

  it("logs each refusal once, as a warning", () => {
    const logged: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logged.push({ level: logLevel, message });
    });
    Effect.runSync(
      answerIpcMessage("controllerUrl.read", channel, readUrl, {
        senderFrame: null,
        mainFrame,
        args: [],
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(logged).toEqual([
      {
        level: "Warn",
        message: ["Main refused a message on controllerUrl.read: the frame that sent it is gone."],
      },
    ]);
  });
});
